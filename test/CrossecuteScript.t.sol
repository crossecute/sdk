// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {TransmitterBase, IConduitTransceiver} from "@crossecute/protocol/messaging/outbound/TransmitterBase.sol";
import {OwnableTransmitter} from "@crossecute/protocol/messaging/outbound/OwnableTransmitter.sol";
import {CrossecuteScript} from "@crossecute/sdk/CrossecuteScript.sol";
import {Plan} from "@crossecute/sdk/Types.sol";
import {MockTransceiver, MockTransmitter, Counter} from "./MockConduit.sol";

/// @dev Every chain in one EVM: the destination is a chain id label, not a fork.
contract Harness is CrossecuteScript {
    constructor(address transmitter_) {
        transmitter = OwnableTransmitter(payable(transmitter_));
    }

    function _selectHome() internal override {}

    function _selectDestination(uint256) internal override {}

    function add(uint256 chainId, Call[] memory calls, bytes[] memory attributes) external returns (uint256) {
        return _add(chainId, calls, attributes);
    }

    function plan() external returns (Plan memory) {
        return _plan();
    }

    function receiverOn(uint256 chainId) external returns (address) {
        return _receiverOn(chainId);
    }

    function writeSafeBatch(Plan memory p, string memory path) external {
        _writeSafeBatch(p, path);
    }

    function writePlan(Plan memory p, string memory path) external {
        _writePlan(p, path);
    }
}

contract CrossecuteScriptTest is Test {
    uint256 constant DEST = 10;
    address constant OWNER = address(0xA11CE);
    address constant RECEIVER = address(0xBEEF);

    MockTransceiver transceiver;
    MockTransmitter transmitter;
    Harness script;
    Counter counter;

    function setUp() public {
        transceiver = new MockTransceiver(RECEIVER);
        transmitter = new MockTransmitter(OWNER, address(transceiver));
        script = new Harness(address(transmitter));
        counter = new Counter();
    }

    function _bump(uint256 value) internal view returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call(address(counter), value, abi.encodeCall(Counter.bump, ()));
    }

    /// @dev Through instances: a public function or getter has no selector on its type.
    function test_mockMatchesProtocolSelectors() public view {
        MockTransmitter m = transmitter;
        OwnableTransmitter t = OwnableTransmitter(payable(address(transmitter)));
        IConduitTransceiver c = IConduitTransceiver(address(transceiver));
        assertEq(m.sendMessage.selector, t.sendMessage.selector);
        assertEq(m.bootstrap.selector, t.bootstrap.selector);
        assertEq(m.quoteMessage.selector, t.quoteMessage.selector);
        assertEq(m.quoteBootstrap.selector, t.quoteBootstrap.selector);
        assertEq(m.recipientOn.selector, t.recipientOn.selector);
        assertEq(m.isBootstrapped.selector, t.isBootstrapped.selector);
        assertEq(m.destinationReceiverOn.selector, t.destinationReceiverOn.selector);
        assertEq(m.transceiver.selector, t.transceiver.selector);
        assertEq(m.deployer.selector, t.deployer.selector);
        assertEq(m.conduitSalt.selector, t.conduitSalt.selector);
        assertEq(m.owner.selector, t.owner.selector);
        assertEq(transceiver.predictReceiver.selector, c.predictReceiver.selector);
        assertEq(transceiver.reportsReceiver.selector, c.reportsReceiver.selector);
    }

    function test_simulatesAsTheReceiver() public {
        vm.deal(RECEIVER, 1 ether);
        script.add(DEST, _bump(0.3 ether), new bytes[](0));
        assertEq(counter.lastCaller(), RECEIVER);
        assertEq(counter.received(), 0.3 ether);
        assertEq(RECEIVER.balance, 0.7 ether);
    }

    function test_firstBatchBootstrapsAndLaterBatchesSend() public {
        script.add(DEST, _bump(0), new bytes[](0));
        script.add(DEST, _bump(0), new bytes[](0));
        Plan memory p = script.plan();

        assertEq(p.owner, OWNER);
        assertTrue(p.batches[0].bootstrap);
        assertFalse(p.batches[1].bootstrap);
        assertEq(p.fee, transmitter.BOOTSTRAP_FEE() + transmitter.MESSAGE_FEE());

        bytes memory body = Payload.encodeCalls(_bump(0));
        bytes memory payload = Payload.encodeBootstrap(Erc7930.encodeEvmChain(DEST), body);
        assertEq(p.calls[0].data, abi.encodeCall(TransmitterBase.bootstrap, (payload, new bytes[](0))));
        bytes memory recipient = Erc7930.encodeEvm(DEST, RECEIVER);
        assertEq(p.calls[1].data, abi.encodeCall(TransmitterBase.sendMessage, (recipient, body, new bytes[](0))));
    }

    function test_planLeavesHomeStateUnchanged() public {
        script.add(DEST, _bump(0), new bytes[](0));
        script.plan();
        assertFalse(transmitter.isBootstrapped(ChainKey.forEvm(DEST)));
        assertEq(transmitter.FEE_SINK().balance, 0);
    }

    function test_topsUpTheTransmitterWithBuffer() public {
        vm.deal(address(transmitter), 0.02 ether);
        script.add(DEST, _bump(0), new bytes[](0));
        Plan memory p = script.plan();
        uint256 needed = transmitter.BOOTSTRAP_FEE() * 11_000 / 10_000;
        assertEq(p.calls[0].value, needed - 0.02 ether);
    }

    function test_noTopUpWhenFunded() public {
        vm.deal(address(transmitter), 1 ether);
        script.add(DEST, _bump(0), new bytes[](0));
        assertEq(script.plan().calls[0].value, 0);
    }

    function test_plannedCallsExecuteAsPlanned() public {
        script.add(DEST, _bump(0), new bytes[](0));
        script.add(DEST, _bump(0), new bytes[](0));
        Plan memory p = script.plan();
        vm.deal(OWNER, p.calls[0].value);
        for (uint256 i; i < p.calls.length; ++i) {
            vm.prank(OWNER);
            (bool ok,) = p.calls[i].to.call{value: p.calls[i].value}(p.calls[i].data);
            assertTrue(ok);
        }
        assertEq(transmitter.FEE_SINK().balance, p.fee);
    }

    function test_revertingCallNamesItsIndex() public {
        Call[] memory calls = new Call[](2);
        calls[0] = _bump(0)[0];
        calls[1] = Call(address(counter), 0, abi.encodeCall(Counter.refuse, ()));
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossecuteScript.CallReverted.selector, DEST, 1, abi.encodeWithSelector(Counter.Refused.selector)
            )
        );
        script.add(DEST, calls, new bytes[](0));
    }

    function test_underfundedReceiverReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(CrossecuteScript.ReceiverUnderfunded.selector, DEST, RECEIVER, 1 ether, 0)
        );
        script.add(DEST, _bump(1 ether), new bytes[](0));
    }

    function test_reportingDestinationIsNotPredicted() public {
        transceiver.setReports(ChainKey.forEvm(DEST), true);
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.ReceiverNotPredictable.selector, DEST));
        script.receiverOn(DEST);
    }

    function test_emptyPlanReverts() public {
        vm.expectRevert(CrossecuteScript.NothingPlanned.selector);
        script.plan();
    }

    function test_safeBatchFile() public {
        script.add(DEST, _bump(0), new bytes[](0));
        Plan memory p = script.plan();
        string memory path = "out/test-safe-batch.json";
        script.writeSafeBatch(p, path);
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".chainId"), vm.toString(block.chainid));
        assertEq(vm.parseJsonAddress(json, ".meta.createdFromSafeAddress"), OWNER);
        assertEq(vm.parseJsonAddress(json, ".transactions[0].to"), address(transmitter));
        assertEq(vm.parseJsonBytes(json, ".transactions[0].data"), p.calls[0].data);
        assertEq(vm.parseJsonString(json, ".transactions[0].operation"), "0");
    }

    function test_planFile() public {
        bytes[] memory attributes = new bytes[](1);
        attributes[0] = hex"deadbeef";
        script.add(DEST, _bump(0), attributes);
        Plan memory p = script.plan();
        string memory path = "out/test-plan.json";
        script.writePlan(p, path);
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".version"), "crossecute-plan/1");
        assertEq(vm.parseJsonUint(json, ".fee"), p.fee);
        assertEq(vm.parseJsonBytes(json, ".calls[0].data"), p.calls[0].data);
        assertEq(vm.parseJsonUint(json, ".batches[0].chainId"), DEST);
        assertEq(vm.parseJsonAddress(json, ".batches[0].receiver"), RECEIVER);
        assertTrue(vm.parseJsonBool(json, ".batches[0].bootstrap"));
        assertEq(vm.parseJsonBytes(json, ".batches[0].attributes[0]"), hex"deadbeef");
        assertEq(vm.parseJsonAddress(json, ".batches[0].calls[0].target"), address(counter));
    }
}
