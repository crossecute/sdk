// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {CrossecuteScript} from "@crossecute/sdk/CrossecuteScript.sol";
import {LzDvn} from "@crossecute/sdk/LzDvn.sol";
import {MockTransceiver, MockTransmitter} from "./MockConduit.sol";
import {MockLzEndpoint, MockLzTransmitter} from "./MockLz.sol";
import {Harness} from "./CrossecuteScript.t.sol";

/// @notice A plain LayerZero conduit's bootstrap is the transceiver's send and its messages are
///         the conduit's own: each is refused while its sender's config toward the destination
///         requires the dead DVN, and accepted once that sender's stack replaces it.
contract LzDeadDvnTest is Test {
    uint256 constant DEST = 252;
    uint32 constant EID = 30255;
    address constant OWNER = address(0xA11CE);
    address constant DVN = address(0xD1);

    MockTransceiver transceiver;
    MockLzEndpoint endpoint;
    MockLzTransmitter transmitter;
    Harness script;

    function setUp() public {
        transceiver = new MockTransceiver(address(0xBEEF));
        endpoint = new MockLzEndpoint();
        transceiver.setMessageProvider(LzDvn.PROVIDER);
        transceiver.setProviderId(ChainKey.forEvm(DEST), EID);
        transceiver.setEndpoint(address(endpoint));
        transmitter = new MockLzTransmitter(OWNER, address(transceiver), address(endpoint));
        script = new Harness(address(transmitter));
        endpoint.setDefault(EID, _stack(LzDvn.DEAD));
    }

    function _stack(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _add() internal {
        script.add(DEST, new Call[](0), new bytes[](0));
    }

    function _pinTransceiver() internal {
        endpoint.pin(address(transceiver), EID, _stack(DVN));
    }

    function _pinConduit() internal {
        endpoint.pin(address(transmitter), EID, _stack(DVN));
    }

    function test_aBootstrapOverAnUnpinnedTransceiverIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.LzTransceiverDeadDvn.selector, DEST, EID));
        _add();
    }

    function test_theConduitsPinDoesNotHelpTheBootstrap() public {
        _pinConduit();
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.LzTransceiverDeadDvn.selector, DEST, EID));
        _add();
    }

    function test_theBootstrapNeedsOnlyTheTransceiversPin() public {
        _pinTransceiver();
        _add();
    }

    function test_aMessageAfterTheBootstrapNeedsTheOwnersSetDvn() public {
        _pinTransceiver();
        _add();
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.LzDeadDvn.selector, DEST, EID));
        _add();

        _pinConduit();
        _add();
    }

    function test_theTransceiversPinDoesNotHelpAMessage() public {
        _pinTransceiver();
        _add();
        // Only the conduit's pin was missing; pinning the transceiver again changes nothing.
        _pinTransceiver();
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.LzDeadDvn.selector, DEST, EID));
        _add();
    }

    function test_theDeadDvnAmongOtherRequiredDvnsIsRefused() public {
        address[] memory required = new address[](2);
        required[0] = DVN;
        required[1] = LzDvn.DEAD;
        endpoint.setDefault(EID, required);
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.LzTransceiverDeadDvn.selector, DEST, EID));
        _add();
    }

    function test_aPinForAnotherPathwayDoesNotHelp() public {
        endpoint.pin(address(transceiver), EID + 1, _stack(DVN));
        vm.expectRevert(abi.encodeWithSelector(CrossecuteScript.LzTransceiverDeadDvn.selector, DEST, EID));
        _add();
    }

    function test_aLiveDefaultIsAcceptedForBoth() public {
        endpoint.setDefault(EID, _stack(DVN));
        _add();
        _add();
    }

    function test_aConduitOfAnotherProviderIsNotChecked() public {
        // `layerzero-oft` has no transmitter `endpoint()` and its stack is the OFT's.
        transceiver.setMessageProvider(keccak256("layerzero-oft"));
        MockTransmitter plain = new MockTransmitter(OWNER, address(transceiver));
        new Harness(address(plain)).add(DEST, new Call[](0), new bytes[](0));
    }
}
