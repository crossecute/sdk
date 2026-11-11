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
import {HomeCall, Batch, Plan} from "./Types.sol";
import {PlanJson} from "./PlanJson.sol";

/// @title CrossecuteScript
/// @notice Base for scripts that run calls on a conduit's receivers. A script forks the home
///         chain and each destination, adds batches (each simulated as the receiver on its
///         destination fork), then turns them into the owner's home-chain calls and hands those
///         to a sink: a Safe Transaction Builder file, a plan file, a Safe API proposal, or a
///         wallet broadcast.
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

    /* ================================== forks ================================== */

    function _useHome(string memory rpcUrl, address transmitter_) internal {
        _homeFork = vm.createFork(rpcUrl);
        transmitter = OwnableTransmitter(payable(transmitter_));
    }

    function _useDestination(string memory rpcUrl) internal returns (uint256 chainId) {
        uint256 fork = vm.createSelectFork(rpcUrl);
        chainId = block.chainid;
        _destinationForks[chainId] = fork + 1;
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

    /// @notice The plan file `crossecute propose` and the TypeScript SDK read.
    function _writePlan(Plan memory plan, string memory path) internal {
        vm.writeFile(path, PlanJson.planFile(plan));
    }

    /// @notice Proposes the plan to the Safe Transaction Service through the SDK's CLI. Needs
    ///         `ffi = true` and the signer settings `crossecute propose` documents.
    function _proposeToSafe(Plan memory plan, string memory path) internal {
        _writePlan(plan, path);
        string[] memory cmd = new string[](5);
        cmd[0] = "npx";
        cmd[1] = "--no-install";
        cmd[2] = "crossecute";
        cmd[3] = "propose";
        cmd[4] = path;
        console2.log(string(vm.ffi(cmd)));
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
