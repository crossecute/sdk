// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {CrossecuteScript} from "@crossecute/sdk/CrossecuteScript.sol";
import {SafeTxHash} from "@crossecute/sdk/SafeTxHash.sol";
import {HomeCall, Plan, SafeTx} from "@crossecute/sdk/Types.sol";
import {Harness} from "./CrossecuteScript.t.sol";
import {MockTransceiver, MockTransmitter, MockRegistry, MockSafe, Counter} from "./MockConduit.sol";

contract SafeTxTest is Test {
    uint256 constant DEST = 10;
    address constant RECEIVER = address(0xBEEF);

    MockSafe safe;
    MockTransceiver transceiver;
    MockTransmitter transmitter;
    MockRegistry registry;
    Harness script;
    Counter counter;

    function setUp() public {
        safe = new MockSafe();
        transceiver = new MockTransceiver(RECEIVER);
        transmitter = new MockTransmitter(address(safe), address(transceiver));
        transceiver.setPredictedTransmitter(address(transmitter));
        registry = new MockRegistry(address(transceiver), transceiver.messageProvider());
        script = new Harness(address(transmitter));
        counter = new Counter();
    }

    function _bump() internal view returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call(address(counter), 0, abi.encodeCall(Counter.bump, ()));
    }

    function _planned(uint256 batches) internal returns (Plan memory) {
        for (uint256 i; i < batches; ++i) {
            script.add(DEST, _bump(), new bytes[](0));
        }
        return script.plan();
    }

    /* ================================ conduit ================================ */

    function test_verifiesARegisteredConduit() public {
        script.verify(address(registry));
    }

    function test_rejectsATransceiverTheRegistryDoesNotPlace() public {
        MockRegistry other = new MockRegistry(address(0xD00D), transceiver.messageProvider());
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossecuteScript.TransceiverNotRegistered.selector, address(transceiver), address(0xD00D)
            )
        );
        script.verify(address(other));
    }

    function test_rejectsATransmitterTheTransceiverDidNotCreate() public {
        transceiver.setPredictedTransmitter(address(0xD00D));
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossecuteScript.TransmitterNotFromTransceiver.selector, address(transmitter), address(0xD00D)
            )
        );
        script.verify(address(registry));
    }

    function test_rejectsATransmitterWithNoCode() public {
        Harness eoa = new Harness(address(0xE0A));
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.NotAConduit.selector, address(0xE0A)));
        eoa.verify(address(registry));
    }

    /* ================================ Safe tx ================================ */

    function test_hashConstantsAreSafes() public pure {
        assertEq(SafeTxHash.SAFE_TX_TYPEHASH, 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8);
        assertEq(SafeTxHash.DOMAIN_TYPEHASH, 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218);
    }

    function test_oneCallIsSentDirectly() public {
        Plan memory p = _planned(1);
        (SafeTx memory t, bytes32 h) = script.safeTx(p, 7);
        assertEq(t.to, address(transmitter));
        assertEq(t.value, p.calls[0].value);
        assertEq(t.data, p.calls[0].data);
        assertEq(t.operation, 0);
        assertEq(t.nonce, 7);
        assertEq(h, safe.getTransactionHash(t.to, t.value, t.data, 0, 0, 0, 0, address(0), address(0), 7));
    }

    function test_severalCallsGoThroughMultiSendCallOnly() public {
        address multiSend = address(new Counter());
        script.setKnownMultiSend(multiSend);
        Plan memory p = _planned(2);
        (SafeTx memory t,) = script.safeTx(p, 8);

        assertEq(t.to, multiSend);
        assertEq(t.operation, 1);
        assertEq(t.value, 0);
        bytes memory packed;
        for (uint256 i; i < p.calls.length; ++i) {
            HomeCall memory c = p.calls[i];
            packed = abi.encodePacked(packed, uint8(0), c.to, c.value, c.data.length, c.data);
        }
        assertEq(t.data, abi.encodeWithSignature("multiSend(bytes)", packed));
    }

    function test_rejectsAUsedNonce() public {
        Plan memory p = _planned(1);
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.SafeNonceUsed.selector, 6, 7));
        script.safeTx(p, 6);
    }

    function test_rejectsAnUnknownSafeVersion() public {
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.UnsupportedSafeVersion.selector, "1.2.0"));
        script.multiSendCallOnly("1.2.0");
    }

    /// @dev No chain here holds the canonical deployment, so its code hash matches nothing.
    function test_rejectsAMultiSendWhoseCodeDiffers() public {
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.NoMultiSendCallOnly.selector, "1.4.1"));
        script.multiSendCallOnly("1.4.1");
    }

    function test_typedDataFile() public {
        // The canonical 1.4.1 address, so the TypeScript check accepts it as known.
        address canonical = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
        vm.etch(canonical, address(counter).code);
        script.setKnownMultiSend(canonical);
        Plan memory p = _planned(2);
        string memory path = "out/test-safe-tx.json";
        bytes32 h = script.writeSafeTx(p, 9, path);
        (SafeTx memory t,) = script.safeTx(p, 9);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".primaryType"), "SafeTx");
        assertEq(vm.parseJsonString(json, ".domain.chainId"), vm.toString(block.chainid));
        assertEq(vm.parseJsonAddress(json, ".domain.verifyingContract"), address(safe));
        assertEq(vm.parseJsonAddress(json, ".message.to"), t.to);
        assertEq(vm.parseJsonBytes(json, ".message.data"), t.data);
        assertEq(vm.parseJsonString(json, ".message.operation"), "1");
        assertEq(vm.parseJsonString(json, ".message.nonce"), "9");
        assertEq(vm.parseJsonString(json, ".types.SafeTx[9].name"), "nonce");

        // For ts/test/safeTx.test.ts, which recomputes the hash with viem.
        script.writePlan(p, "out/test-safe-tx-plan.json");
        vm.writeFile("out/test-safe-tx-hash.txt", vm.toString(h));
    }
}
