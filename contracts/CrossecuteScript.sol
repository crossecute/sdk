// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {DeliveryGas} from "@crossecute/protocol/messaging/DeliveryGas.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {IConduitTransceiver} from "@crossecute/protocol/messaging/outbound/TransmitterBase.sol";
import {OwnableTransmitter} from "@crossecute/protocol/messaging/outbound/OwnableTransmitter.sol";
import {TransceiverExtension} from "@crossecute/protocol/messaging/transceiver/TransceiverExtension.sol";
import {ChainRegistry} from "@crossecute/protocol/registry/ChainRegistry.sol";
import {HomeCall, Batch, Plan, SafeTx} from "./Types.sol";
import {PlanJson} from "./PlanJson.sol";
import {ISafe} from "./ISafe.sol";
import {SafeTxHash} from "./SafeTxHash.sol";

/// @title CrossecuteScript
/// @notice Base for scripts that run calls on a conduit's receivers. A script runs on the home
///         chain (`--fork-url`), forks each destination, adds batches (each simulated as the receiver on its
///         destination fork), then turns them into the owner's home-chain calls and hands those
///         to a sink: a Safe Transaction Builder file, a plan file, the Safe transaction's
///         EIP-712 typed data, or a wallet broadcast.
///
/// @dev Receiver addresses come from the deployed transmitter and transceiver, never from a
///      local `ProxyInitCode.hash()`, which depends on this project's compiler settings.
///
/// @dev Simulation runs each call from the receiver's address. Where the receiver is not yet
///      deployed, a call back into it meets no code, so callbacks it would refuse succeed here.
abstract contract CrossecuteScript is Script {
    OwnableTransmitter internal transmitter;

    /// Headroom on the quoted fee for price movement before execution. The excess stays in the
    /// transmitter and pays later sends.
    uint256 internal feeBufferBps = 1000;

    uint256 private _homeFork;
    mapping(uint256 chainId => uint256 forkPlusOne) private _destinationForks;
    mapping(uint256 chainId => bool) private _bootstrapQueued;
    Batch[] private _batches;

    error UnknownDestination(uint256 chainId);
    error ReceiverNotPredictable(uint256 chainId);
    error MalformedReceiver(uint256 chainId, bytes receiver);
    error ReceiverUnderfunded(uint256 chainId, address receiver, uint256 needed, uint256 balance);
    error CallReverted(uint256 chainId, uint256 index, bytes reason);
    error HomeCallReverted(uint256 index, bytes reason);
    error OwnerIsContract(address owner);
    error NothingPlanned();
    error NotAConduit(address transmitter);
    error TransceiverNotRegistered(address transceiver, address expected);
    error TransmitterNotFromTransceiver(address transmitter, address expected);
    error SafeNonceUsed(uint256 nonce, uint256 current);
    error SafeTxHashMismatch(bytes32 safe, bytes32 local);
    error UnsupportedSafeVersion(string version);
    error NoMultiSendCallOnly(string version);

    /// `multiSend(bytes)`.
    bytes4 internal constant MULTI_SEND = 0x8d80ff0a;

    /* ================================== forks ================================== */

    /// @notice Takes the chain the script runs on (`--fork-url`, which Forge Attest pins with
    ///         `fork_block`) as the conduit's home, and checks `transmitter_` descends from
    ///         `registry`. Call before `_useDestination`.
    function _useHome(address registry, address transmitter_) internal {
        _homeFork = vm.activeFork();
        transmitter = OwnableTransmitter(payable(transmitter_));
        _verifyConduit(registry);
    }

    function _useDestination(string memory rpcUrl) internal returns (uint256 chainId) {
        return _registerDestination(vm.createSelectFork(rpcUrl));
    }

    /// @notice A destination fork at a fixed block, so a re-run simulates against the same state.
    function _useDestination(string memory rpcUrl, uint256 blockNumber) internal returns (uint256 chainId) {
        return _registerDestination(vm.createSelectFork(rpcUrl, blockNumber));
    }

    function _registerDestination(uint256 fork) private returns (uint256 chainId) {
        chainId = block.chainid;
        _destinationForks[chainId] = fork + 1;
        _selectHome();
    }

    /// @dev Virtual so a test can run every chain in one EVM.
    function _selectHome() internal virtual {
        vm.selectFork(_homeFork);
    }

    function _selectDestination(uint256 chainId) internal virtual {
        uint256 fork = _destinationForks[chainId];
        if (fork == 0) revert UnknownDestination(chainId);
        vm.selectFork(fork - 1);
    }

    /* ================================= conduit ================================= */

    /// @notice Reverts unless the registry places the transmitter's transceiver for its provider
    ///         on this chain, and that transceiver's CREATE2 places the transmitter.
    /// @dev Every later read (receiver, route, quote) trusts the transmitter and transceiver, so
    ///      a lookalike transmitter could otherwise steer simulation and planning. The provider
    ///      and the CREATE2 inputs are read from the contracts being checked, which is sound
    ///      because each is bound by an address derived from the trusted registry. A home whose
    ///      CREATE2 is not `Predetermined` (zkSync, Tron) has no registry prediction and fails here.
    function _verifyConduit(address registry) internal virtual {
        _selectHome();
        if (address(transmitter).code.length == 0) revert NotAConduit(address(transmitter));
        TransceiverExtension transceiver = TransceiverExtension(payable(transmitter.transceiver()));
        address expected =
            ChainRegistry(registry).predictTransceiver(ChainKey.forEvm(block.chainid), transceiver.messageProvider());
        if (address(transceiver) != expected) revert TransceiverNotRegistered(address(transceiver), expected);
        expected = transceiver.predictTransmitter(transmitter.deployer(), transmitter.conduitSalt());
        if (address(transmitter) != expected) revert TransmitterNotFromTransceiver(address(transmitter), expected);
    }

    /* ================================ receivers ================================ */

    /// @notice The conduit's receiver on an EVM destination: the recorded one once bootstrapped,
    ///         otherwise the home transceiver's prediction.
    function _receiverOn(uint256 chainId) internal returns (address) {
        _selectHome();
        bytes32 key = ChainKey.forEvm(chainId);
        if (transmitter.isBootstrapped(key)) {
            bytes memory recorded = transmitter.destinationReceiverOn(key);
            // A reporting destination has no receiver until its report arrives home.
            if (recorded.length == 0) revert ReceiverNotPredictable(chainId);
            return _toAddress(chainId, recorded);
        }
        IConduitTransceiver transceiver = IConduitTransceiver(transmitter.transceiver());
        if (transceiver.reportsReceiver(key)) revert ReceiverNotPredictable(chainId);
        return _toAddress(chainId, transceiver.predictReceiver(key, transmitter.deployer(), transmitter.conduitSalt()));
    }

    function _toAddress(uint256 chainId, bytes memory raw) private pure returns (address) {
        if (raw.length != 20) revert MalformedReceiver(chainId, raw);
        return address(bytes20(raw));
    }

    /* ================================= batches ================================= */

    /// @notice Simulate `calls` as the receiver on `chainId` and queue them. Batches to one
    ///         destination run in the order added; the first to an unbootstrapped destination
    ///         becomes its bootstrap. Empty `attributes` take the provider's default gas.
    /// @dev The destination fork keeps the batch's effects, so a later batch simulates on top.
    function _add(uint256 chainId, Call[] memory calls, bytes[] memory attributes) internal returns (uint256 gasUsed) {
        address receiver = _receiverOn(chainId);
        bool bootstrap = !transmitter.isBootstrapped(ChainKey.forEvm(chainId)) && !_bootstrapQueued[chainId];
        if (bootstrap) _bootstrapQueued[chainId] = true;

        gasUsed = _simulate(chainId, receiver, calls);

        Batch storage b = _batches.push();
        b.chainId = chainId;
        b.receiver = receiver;
        b.attributes = attributes;
        b.gasUsed = gasUsed;
        b.bootstrap = bootstrap;
        for (uint256 i; i < calls.length; ++i) {
            b.calls.push(calls[i]);
        }

        if (attributes.length == 0) {
            uint256 limit = bootstrap ? DeliveryGas.BOOTSTRAP : DeliveryGas.PAYLOAD;
            // The default also covers receiver creation or dispatch, so calls under it can still
            // run short.
            if (gasUsed > limit) {
                console2.log(
                    "calls on chain %s use %s gas, over the default %s: pass a gas attribute", chainId, gasUsed, limit
                );
            }
        }
    }

    function _simulate(uint256 chainId, address receiver, Call[] memory calls) internal returns (uint256 gasUsed) {
        _selectDestination(chainId);
        uint256 needed;
        for (uint256 i; i < calls.length; ++i) {
            needed += calls[i].value;
        }
        if (receiver.balance < needed) revert ReceiverUnderfunded(chainId, receiver, needed, receiver.balance);
        if (receiver.code.length == 0) {
            console2.log(
                "receiver %s on chain %s is not deployed: callbacks into it are not simulated", receiver, chainId
            );
        }

        for (uint256 i; i < calls.length; ++i) {
            vm.prank(receiver);
            uint256 before = gasleft();
            (bool ok, bytes memory reason) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            gasUsed += before - gasleft();
            if (!ok) revert CallReverted(chainId, i, reason);
        }
    }

    /* =================================== plan ================================== */

    /// @notice The owner's home-chain calls for every queued batch, checked by running them as
    ///         the owner on the home fork. Leaves the home fork as it found it.
    function _plan() internal returns (Plan memory plan) {
        if (_batches.length == 0) revert NothingPlanned();
        _selectHome();
        plan.homeChainId = block.chainid;
        plan.transmitter = address(transmitter);
        plan.owner = transmitter.owner();
        plan.batches = _batches;
        plan.calls = new HomeCall[](_batches.length);

        // Quotes in order, each after the calls before it, since a bootstrap changes what follows.
        uint256 snapshot = vm.snapshotState();
        vm.deal(address(transmitter), type(uint128).max);
        for (uint256 i; i < plan.batches.length; ++i) {
            uint256 fee;
            (plan.calls[i], fee) = _homeCallFor(plan.batches[i]);
            plan.fee += fee;
            _runAsOwner(plan.owner, plan.calls[i], i);
        }
        vm.revertToStateAndDelete(snapshot);

        uint256 needed = plan.fee + plan.fee * feeBufferBps / 10_000;
        uint256 balance = address(transmitter).balance;
        if (needed > balance) plan.calls[0].value = needed - balance;

        snapshot = vm.snapshotState();
        if (plan.owner.balance < plan.calls[0].value) {
            console2.log("owner %s needs %s wei to top up the transmitter", plan.owner, plan.calls[0].value);
            vm.deal(plan.owner, plan.calls[0].value);
        }
        for (uint256 i; i < plan.calls.length; ++i) {
            _runAsOwner(plan.owner, plan.calls[i], i);
        }
        vm.revertToStateAndDelete(snapshot);
    }

    function _homeCallFor(Batch memory b) private view returns (HomeCall memory call, uint256 fee) {
        bytes memory body = Payload.encodeCalls(b.calls);
        call.to = address(transmitter);
        if (transmitter.isBootstrapped(ChainKey.forEvm(b.chainId))) {
            bytes memory recipient = transmitter.recipientOn(b.chainId);
            call.data = abi.encodeCall(transmitter.sendMessage, (recipient, body, b.attributes));
            fee = transmitter.quoteMessage(recipient, body, b.attributes);
        } else {
            bytes memory payload = Payload.encodeBootstrap(Erc7930.encodeEvmChain(b.chainId), body);
            call.data = abi.encodeCall(transmitter.bootstrap, (payload, b.attributes));
            fee = transmitter.quoteBootstrap(payload, b.attributes);
        }
    }

    function _runAsOwner(address owner, HomeCall memory call, uint256 index) private {
        vm.prank(owner);
        (bool ok, bytes memory reason) = call.to.call{value: call.value}(call.data);
        if (!ok) revert HomeCallReverted(index, reason);
    }

    /* =================================== sinks ================================= */

    /// @notice A Safe Transaction Builder file for the owner Safe.
    function _writeSafeBatch(Plan memory plan, string memory path) internal {
        vm.writeFile(path, PlanJson.safeBatch(plan));
    }

    /// @notice The plan file the TypeScript SDK reads and `crossecute check` verifies.
    function _writePlan(Plan memory plan, string memory path) internal {
        vm.writeFile(path, PlanJson.planFile(plan));
    }

    /// @notice The plan as one Safe transaction at `nonce`, written as the EIP-712 typed data
    ///         owners sign: Forge Attest's `safe-eip712` input, and what
    ///         `cast wallet sign --data --from-file` signs.
    /// @dev The bytes depend only on the plan, the nonce and the home fork's state, so a re-run
    ///      at the same home block and nonce writes the same file.
    function _writeSafeTx(Plan memory plan, uint256 nonce, string memory path) internal returns (bytes32 safeTxHash) {
        SafeTx memory t;
        (t, safeTxHash) = _safeTx(plan, nonce);
        vm.writeFile(path, PlanJson.safeTxTypedData(plan.homeChainId, plan.owner, t));
    }

    /// @notice The one Safe transaction carrying `plan`: its call directly, or several through
    ///         MultiSendCallOnly. Checked against the owner Safe's own `getTransactionHash`.
    function _safeTx(Plan memory plan, uint256 nonce) internal returns (SafeTx memory t, bytes32 safeTxHash) {
        _selectHome();
        ISafe safe = ISafe(plan.owner);
        uint256 current = safe.nonce();
        if (nonce < current) revert SafeNonceUsed(nonce, current);

        t.nonce = nonce;
        if (plan.calls.length == 1) {
            t.to = plan.calls[0].to;
            t.value = plan.calls[0].value;
            t.data = plan.calls[0].data;
        } else {
            t.to = _multiSendCallOnly(safe.VERSION());
            t.operation = 1;
            t.data = abi.encodeWithSelector(MULTI_SEND, _multiSendPacked(plan.calls));
        }

        safeTxHash = SafeTxHash.hash(block.chainid, plan.owner, t);
        bytes32 live = safe.getTransactionHash(
            t.to,
            t.value,
            t.data,
            t.operation,
            t.safeTxGas,
            t.baseGas,
            t.gasPrice,
            t.gasToken,
            t.refundReceiver,
            t.nonce
        );
        if (live != safeTxHash) revert SafeTxHashMismatch(live, safeTxHash);

        console2.log("Safe %s on chain %s, nonce %s", plan.owner, block.chainid, nonce);
        console2.log("domain hash:  %s", vm.toString(SafeTxHash.domainSeparator(block.chainid, plan.owner)));
        console2.log("message hash: %s", vm.toString(SafeTxHash.structHash(t)));
        console2.log("safeTxHash:   %s", vm.toString(safeTxHash));
    }

    /// @notice The MultiSendCallOnly a Safe of `version` uses on this chain: the first known
    ///         deployment whose code matches.
    function _multiSendCallOnly(string memory version) internal view returns (address) {
        (address[] memory candidates, bytes32 codeHash) = _knownMultiSendCallOnly(version);
        for (uint256 i; i < candidates.length; ++i) {
            if (candidates[i].codehash == codeHash) return candidates[i];
        }
        revert NoMultiSendCallOnly(version);
    }

    /// @dev From @safe-global/safe-deployments 1.37.67 (`multi_send_call_only.json`), canonical
    ///      and eip155 deployments. Virtual so a test can name a deployment it etched.
    function _knownMultiSendCallOnly(string memory version)
        internal
        view
        virtual
        returns (address[] memory candidates, bytes32 codeHash)
    {
        bytes32 v = keccak256(bytes(version));
        if (v == keccak256("1.3.0")) {
            candidates = new address[](2);
            candidates[0] = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
            candidates[1] = 0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B;
            codeHash = 0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad;
        } else if (v == keccak256("1.4.1")) {
            candidates = new address[](1);
            candidates[0] = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
            codeHash = 0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939;
        } else if (v == keccak256("1.5.0")) {
            candidates = new address[](1);
            candidates[0] = 0xA83c336B20401Af773B6219BA5027174338D1836;
            codeHash = 0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663;
        } else {
            revert UnsupportedSafeVersion(version);
        }
    }

    /// @dev MultiSend's packed transactions: operation, to, value, data length, data.
    function _multiSendPacked(HomeCall[] memory calls) private pure returns (bytes memory packed) {
        for (uint256 i; i < calls.length; ++i) {
            packed =
                abi.encodePacked(packed, uint8(0), calls[i].to, calls[i].value, calls[i].data.length, calls[i].data);
        }
    }

    /// @notice Sends the plan from an EOA owner with the script's signer.
    function _broadcast(Plan memory plan) internal {
        _selectHome();
        if (plan.owner.code.length != 0) revert OwnerIsContract(plan.owner);
        vm.startBroadcast(plan.owner);
        for (uint256 i; i < plan.calls.length; ++i) {
            (bool ok, bytes memory reason) = plan.calls[i].to.call{value: plan.calls[i].value}(plan.calls[i].data);
            if (!ok) revert HomeCallReverted(i, reason);
        }
        vm.stopBroadcast();
    }
}
