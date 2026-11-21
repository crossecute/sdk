// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {ISignedReceiver} from "@crossecute/protocol/messaging/inbound/ISignedReceiver.sol";
import {OwnableTransmitter} from "@crossecute/protocol/messaging/outbound/OwnableTransmitter.sol";
import {CrossecuteScript} from "../contracts/CrossecuteScript.sol";
import {MerklePackageScript} from "../contracts/MerklePackageScript.sol";
import {MerklePackage, MerklePackages} from "../contracts/MerklePackage.sol";
import {MerklePackageJson} from "../contracts/MerklePackageJson.sol";
import {SignedDispatch} from "../contracts/SignedDispatch.sol";
import {MockTransceiver, MockTransmitter, MockSignedReceiver, Counter} from "./MockConduit.sol";

/// @dev Every chain in one EVM, as in `CrossecuteScriptTest`: a destination is a chain id label, not a fork.
contract PackageScript is MerklePackageScript {
    constructor(address transmitter_) {
        transmitter = OwnableTransmitter(payable(transmitter_));
    }

    function _selectHome() internal override {}

    function _selectDestination(uint256) internal override {}

    function addLeaf(
        uint256 chainId,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) external returns (uint256, uint256) {
        return _addLeaf(chainId, validAfter, deadline, calls, attributes);
    }

    function addLeafAt(
        uint256 chainId,
        uint256 nonce,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) external returns (uint256) {
        return _addLeaf(chainId, nonce, validAfter, deadline, calls, attributes);
    }

    function build() external view returns (MerklePackage memory) {
        return _merklePackage();
    }

    function write(string memory path) external {
        _writeMerklePackage(_merklePackage(), path);
    }
}

contract MerklePackageScriptTest is Test {
    uint256 constant DEST = 10;
    uint256 constant OTHER = 11;
    address constant OWNER = address(0xA11CE);

    MockSignedReceiver receiver;
    MockTransceiver transceiver;
    MockTransmitter transmitter;
    PackageScript script;
    Counter counter;

    function setUp() public {
        receiver = new MockSignedReceiver(4);
        transceiver = new MockTransceiver(address(receiver));
        transmitter = new MockTransmitter(OWNER, address(transceiver));
        script = new PackageScript(address(transmitter));
        counter = new Counter();
    }

    function _bump() internal view returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call(address(counter), 0, abi.encodeCall(Counter.bump, ()));
    }

    function _attributes(bytes memory a) internal pure returns (bytes[] memory attributes) {
        attributes = new bytes[](1);
        attributes[0] = a;
    }

    function test_mockMatchesProtocolSelector() public view {
        assertEq(receiver.nextNonce.selector, ISignedReceiver.nextNonce.selector);
    }

    function test_receiverAndNonceComeFromTheConduit() public {
        script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        MerklePackage memory pkg = script.build();

        bytes memory destination = Erc7930.encodeEvm(DEST, address(receiver));
        assertEq(pkg.receiverNonces.length, 1);
        assertEq(pkg.receiverNonces[0].destination, destination);
        assertEq(pkg.receiverNonces[0].nextNonce, 4);
        assertEq(pkg.leaves[0].leaf.destination, destination);
        assertEq(pkg.leaves[0].leaf.nonce, 4);
        assertEq(pkg.leaves[0].leaf.calls, Payload.encodeCalls(_bump()));
    }

    function test_bootstrappedDestinationUsesTheRecordedRecipient() public {
        vm.deal(address(transmitter), 1 ether);
        vm.prank(OWNER);
        transmitter.bootstrap(
            Payload.encodeBootstrap(Erc7930.encodeEvmChain(DEST), Payload.encodeCalls(new Call[](0))), new bytes[](0)
        );
        script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        assertEq(script.build().leaves[0].leaf.destination, transmitter.recipientOn(DEST));
    }

    function test_nonceAdvancesPerReceiver() public {
        (uint256 n0,) = script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        (uint256 n1,) = script.addLeaf(DEST, 0, 1000, _bump(), _attributes(hex"aa"));
        (uint256 m0,) = script.addLeaf(OTHER, 0, 1000, _bump(), new bytes[](0));
        assertEq(n0, 4);
        assertEq(n1, 5);
        assertEq(m0, 4);

        MerklePackage memory pkg = script.build();
        assertEq(pkg.leaves.length, 3);
        assertEq(pkg.receiverNonces.length, 2);
    }

    function test_nextNonceIsObservedOnce() public {
        script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        vm.etch(address(receiver), address(new MockSignedReceiver(9)).code);
        (uint256 nonce,) = script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        assertEq(nonce, 5);
        assertEq(script.build().receiverNonces[0].nextNonce, 4);
    }

    function test_explicitNonceAllowsOtherAttributesAndAdvancesTheFreeNonce() public {
        script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        script.addLeafAt(DEST, 4, 0, 1000, _bump(), _attributes(hex"bb"));
        (uint256 next,) = script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        assertEq(next, 5);
        assertEq(script.build().leaves.length, 3);
    }

    function test_explicitStaleNonceRevertsAtBuild() public {
        script.addLeafAt(DEST, 3, 0, 1000, _bump(), new bytes[](0));
        vm.expectRevert(abi.encodeWithSelector(MerklePackages.StaleNonce.selector, 0, 3, 4));
        script.build();
    }

    function test_undeployedReceiverStartsAtZero() public {
        MockTransceiver bare = new MockTransceiver(address(0xBEEF));
        PackageScript fresh = new PackageScript(address(new MockTransmitter(OWNER, address(bare))));
        (uint256 nonce,) = fresh.addLeaf(DEST, 0, 1000, new Call[](0), new bytes[](0));
        assertEq(nonce, 0);
        assertEq(fresh.build().receiverNonces[0].nextNonce, 0);
    }

    function test_receiverWithoutNextNonceReverts() public {
        address plain = address(counter);
        PackageScript other =
            new PackageScript(address(new MockTransmitter(OWNER, address(new MockTransceiver(plain)))));
        vm.expectRevert(abi.encodeWithSelector(MerklePackageScript.ReceiverNonceUnreadable.selector, DEST, plain));
        other.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
    }

    function test_simulatesTheCallsAsTheReceiver() public {
        script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        assertEq(counter.lastCaller(), address(receiver));
    }

    function test_failingCallReverts() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(counter), 0, abi.encodeCall(Counter.refuse, ()));
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossecuteScript.CallReverted.selector, DEST, 0, abi.encodeWithSelector(Counter.Refused.selector)
            )
        );
        script.addLeaf(DEST, 0, 1000, calls, new bytes[](0));
    }

    function test_writesTheBuiltPackage() public {
        script.addLeaf(DEST, 0, 1000, _bump(), new bytes[](0));
        script.addLeaf(DEST, 0, 1000, _bump(), _attributes(hex"aa"));
        script.write("out/merkle-package-script.json");
        assertEq(vm.readFile("out/merkle-package-script.json"), MerklePackageJson.toJson(script.build()));
    }

    function test_emptyPlanReverts() public {
        vm.expectRevert(abi.encodeWithSelector(SignedDispatch.NoLeaves.selector));
        script.build();
    }
}
