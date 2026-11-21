// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthorityRelayScript, IAuthorityRelayMulticall} from "../contracts/AuthorityRelayScript.sol";
import {PlanJson} from "../contracts/PlanJson.sol";
import {SafeTx} from "../contracts/Types.sol";
import {SafeTxHash} from "../contracts/SafeTxHash.sol";
import {ISignedTransmitter} from "../contracts/vendor/protocol135/ISignedTransmitter.sol";

/// @dev Quotes `fee` only for `payer`, so a wrong quote account changes the proposal.
contract QuoteByCaller {
    address immutable PAYER;
    uint256 immutable FEE;

    constructor(address payer, uint256 fee) {
        PAYER = payer;
        FEE = fee;
    }

    function quoteAuthority(bytes calldata, bytes calldata, bytes[] calldata) external view returns (uint256) {
        return msg.sender == PAYER ? FEE : type(uint256).max;
    }
}

/// @dev Writes vectors/authority-relay-{single,batch}.json, which ts/test/authority.test.ts replays against the SDK builders.
contract AuthorityRelayScriptTest is Test, AuthorityRelayScript {
    address constant SAFE = address(0x1234);
    address constant MULTICALL = address(0x9999);
    address constant T0 = address(0x5678);
    address constant T1 = address(0x5679);

    function _relay(address transmitter) internal pure returns (Relay memory relay) {
        relay.sourceChainId = 10;
        relay.safe = SAFE;
        relay.transmitter = transmitter;
        relay.nonce = 12;
        relay.recipient = hex"0102";
        relay.submission = hex"aabb";
        relay.attributes = new bytes[](1);
        relay.attributes[0] = hex"1234";
    }

    function _quoter(address at, address payer, uint256 fee) internal {
        vm.etch(at, address(new QuoteByCaller(payer, fee)).code);
    }

    function _batch() internal pure returns (Relay[] memory relays) {
        relays = new Relay[](2);
        relays[0] = _relay(T0);
        relays[1] = _relay(T1);
    }

    function testWritesAttestableSafeRelay() public {
        _quoter(T0, SAFE, 17);
        Relay memory relay = _relay(T0);
        SafeTx memory proposal = _authorityRelayTx(relay, relay.safe);

        assertEq(proposal.to, relay.transmitter);
        assertEq(proposal.nonce, relay.nonce);
        assertEq(proposal.operation, 0);
        assertEq(proposal.value, 17);
        assertEq(
            proposal.data,
            abi.encodeCall(ISignedTransmitter.relayAuthority, (relay.recipient, relay.submission, relay.attributes))
        );
        vm.writeFile(
            "out/test-authority-relay-safe-tx.json", PlanJson.safeTxTypedData(relay.sourceChainId, relay.safe, proposal)
        );
        bytes32 single = SafeTxHash.hash(relay.sourceChainId, relay.safe, proposal);
        vm.writeFile("out/test-authority-relay-safe-tx-hash.txt", vm.toString(single));
        _writeVector(single);
    }

    function testBatchQuotesAsMulticallAndSumsValue() public {
        _quoter(T0, MULTICALL, 17);
        _quoter(T1, MULTICALL, 23);
        Relay[] memory relays = _batch();
        SafeTx memory proposal = _authorityRelayBatchTx(relays, MULTICALL);

        IAuthorityRelayMulticall.Call3Value[] memory calls = new IAuthorityRelayMulticall.Call3Value[](2);
        for (uint256 i; i < 2; ++i) {
            calls[i] = IAuthorityRelayMulticall.Call3Value(
                relays[i].transmitter,
                false,
                i == 0 ? 17 : 23,
                abi.encodeCall(
                    ISignedTransmitter.relayAuthority, (relays[i].recipient, relays[i].submission, relays[i].attributes)
                )
            );
        }
        assertEq(proposal.to, MULTICALL);
        assertEq(proposal.operation, 0);
        assertEq(proposal.value, 40);
        assertEq(proposal.nonce, 12);
        assertEq(proposal.data, abi.encodeCall(IAuthorityRelayMulticall.aggregate3Value, (calls)));
        vm.writeFile(
            "out/test-authority-relay-batch-safe-tx.json", PlanJson.safeTxTypedData(10, SAFE, proposal)
        );
        vm.writeFile(
            "out/test-authority-relay-batch-safe-tx-hash.txt", vm.toString(SafeTxHash.hash(10, SAFE, proposal))
        );
        _writeBatchVector(SafeTxHash.hash(10, SAFE, proposal));
    }

    function testBatchRejectsEmptyAndMismatchedRelays() public {
        _quoter(T0, MULTICALL, 17);
        _quoter(T1, MULTICALL, 23);
        vm.expectRevert(InvalidRelayBatch.selector);
        this.batchTx(new Relay[](0), MULTICALL);

        Relay[] memory relays = _batch();
        relays[1].nonce = 13;
        vm.expectRevert(abi.encodeWithSelector(RelayBatchMismatch.selector, 1));
        this.batchTx(relays, MULTICALL);

        relays = _batch();
        relays[1].safe = address(0x4321);
        vm.expectRevert(abi.encodeWithSelector(RelayBatchMismatch.selector, 1));
        this.batchTx(relays, MULTICALL);

        relays = _batch();
        relays[1].sourceChainId = 1;
        vm.expectRevert(abi.encodeWithSelector(RelayBatchMismatch.selector, 1));
        this.batchTx(relays, MULTICALL);

        vm.expectRevert(InvalidRelayBatch.selector);
        this.writeBatch(_batch(), new string[](1));
    }

    function testRejectsWrongSourceChainBeforeForking() public {
        Relay memory relay = _relay(T0);
        vm.expectRevert(abi.encodeWithSelector(WrongRelayChain.selector, 10, block.chainid));
        this.write(relay, "unused", "out/unused.json");

        Relay[] memory relays = _batch();
        _quoter(T0, MULTICALL, 17);
        _quoter(T1, MULTICALL, 23);
        string[] memory rpcs = new string[](2);
        vm.expectRevert(abi.encodeWithSelector(WrongRelayChain.selector, 10, block.chainid));
        this.writeBatch(relays, rpcs);
    }

    function batchTx(Relay[] memory relays, address multicall) external returns (SafeTx memory) {
        return _authorityRelayBatchTx(relays, multicall);
    }

    function write(Relay memory relay, string memory rpc, string memory output) external {
        _writeAuthorityRelay(relay, rpc, output);
    }

    function writeBatch(Relay[] memory relays, string[] memory rpcs) external {
        _writeAuthorityRelayBatch(relays, rpcs, MULTICALL, "out/unused.json");
    }

    function _writeVector(bytes32 single) internal {
        string memory obj = "single";
        vm.serializeUint(obj, "chainId", 10);
        vm.serializeAddress(obj, "safe", SAFE);
        vm.serializeUint(obj, "nonce", 12);
        vm.serializeAddress(obj, "transmitter", T0);
        vm.serializeBytes(obj, "recipient", hex"0102");
        vm.serializeBytes(obj, "submission", hex"aabb");
        vm.serializeBytes(obj, "attribute", hex"1234");
        vm.serializeUint(obj, "fee", 17);
        vm.writeFile("vectors/authority-relay-single.json", vm.serializeBytes32(obj, "safeTxHash", single));
    }

    function _writeBatchVector(bytes32 batch) internal {
        string memory obj = "batch";
        address[] memory transmitters = new address[](2);
        transmitters[0] = T0;
        transmitters[1] = T1;
        uint256[] memory fees = new uint256[](2);
        fees[0] = 17;
        fees[1] = 23;
        vm.serializeUint(obj, "chainId", 10);
        vm.serializeAddress(obj, "safe", SAFE);
        vm.serializeUint(obj, "nonce", 12);
        vm.serializeAddress(obj, "multicall", MULTICALL);
        vm.serializeAddress(obj, "transmitters", transmitters);
        vm.serializeUint(obj, "fees", fees);
        vm.serializeBytes(obj, "recipient", hex"0102");
        vm.serializeBytes(obj, "submission", hex"aabb");
        vm.serializeBytes(obj, "attribute", hex"1234");
        vm.writeFile("vectors/authority-relay-batch.json", vm.serializeBytes32(obj, "safeTxHash", batch));
    }
}
