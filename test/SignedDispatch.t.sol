// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignedDispatch} from "../contracts/SignedDispatch.sol";
import {SafeTx, SignedSafeTx} from "../contracts/vendor/protocol135/ICrossecuteGuard.sol";
import {SafeHashes} from "../contracts/vendor/protocol135/SafeHashes.sol";
import {DispatchLeaves} from "../contracts/vendor/protocol135/DispatchLeaves.sol";
import {
    ExecutionLeaf,
    SafeTxEvidence,
    NestedSafeApproval,
    SignedBootstrap
} from "../contracts/vendor/protocol135/SignedDispatchTypes.sol";
import {AuthorityGraph, AuthorityNode} from "../contracts/vendor/protocol135/AuthorityGraph.sol";
import {SafeAuthorityRecord, SafeOwner} from "../contracts/vendor/protocol135/SafeAuthorityTypes.sol";
import {ISignedTransmitter} from "../contracts/vendor/protocol135/ISignedTransmitter.sol";
import {SafeBatchExecutor, ISafeExec} from "../contracts/vendor/protocol135/SafeBatchExecutor.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";

contract SignedDispatchTest is Test {
    address constant GUARD = address(0x4444);
    bytes32 constant HEAD = bytes32(uint256(0xfeed));
    bytes constant BOOTSTRAP_DESTINATION = hex"00010000010a00";

    function execution() internal pure returns (ExecutionLeaf memory) {
        bytes[] memory attributes = new bytes[](1);
        attributes[0] = hex"1234";
        return ExecutionLeaf(
            hex"00010000010a141111111111111111111111111111111111111111", 7, 100, 200, hex"abcdef", attributes
        );
    }

    function fixture() internal pure returns (SafeTxEvidence memory e) {
        e.signedSafeTx = SignedSafeTx(SignedDispatch.transaction(address(0x2222), 42, hex"abcdef", 3), hex"123456");
        e.nestedApprovals = new NestedSafeApproval[](1);
        e.nestedApprovals[0] = NestedSafeApproval(
            address(0x3333),
            bytes32(uint256(5)),
            SignedSafeTx(SignedDispatch.transaction(address(0x4444), 2, hex"7788", 0), hex"aabb")
        );
    }

    /// @dev Root 0x7777 with a nested Safe 0x3333 selected at position 0x...09; the root's position is zero.
    function graph() internal pure returns (AuthorityGraph memory g) {
        g.nodes = new AuthorityNode[](2);
        SafeOwner[] memory rootOwners = new SafeOwner[](2);
        rootOwners[0] = SafeOwner(address(0x5555), 0);
        rootOwners[1] = SafeOwner(address(0x3333), 1);
        SafeOwner[] memory childOwners = new SafeOwner[](1);
        childOwners[0] = SafeOwner(address(0x6666), 0);
        g.nodes[0] = AuthorityNode(SafeAuthorityRecord(address(0x7777), 2, rootOwners), bytes32(0));
        g.nodes[1] = AuthorityNode(SafeAuthorityRecord(address(0x3333), 1, childOwners), bytes32(uint256(9)));
    }

    function emptySetup() internal pure returns (bytes memory) {
        return abi.encode(new Call[](0));
    }

    function test_writeSignedVectors() public {
        ExecutionLeaf memory leaf = execution();
        SafeTxEvidence memory e = fixture();
        bytes32[] memory proof = new bytes32[](0);
        bytes memory body = SignedDispatch.bootstrapBody(GUARD, HEAD, graph(), emptySetup());
        string memory key = "signed";
        vm.serializeBytes(key, "executionFields", SignedDispatch.encodeLeaf(leaf));
        vm.serializeBytes32(key, "executionHash", DispatchLeaves.hash(leaf));
        vm.serializeBytes32(key, "executionId", DispatchLeaves.executionId(leaf));
        vm.serializeBytes(key, "authorityGraph", abi.encode(graph()));
        vm.serializeBytes(key, "bootstrapBody", body);
        vm.serializeBytes(
            key, "bootstrapData", SignedDispatch.bootstrapData(BOOTSTRAP_DESTINATION, body, leaf.attributes)
        );
        vm.serializeBytes(key, "sendData", SignedDispatch.sendData(leaf.destination, leaf.calls, leaf.attributes));
        vm.serializeBytes(key, "standaloneWire", SignedDispatch.standaloneWire(e));
        vm.serializeBytes(key, "merkleWire", SignedDispatch.merkleWire(e, leaf, proof));
        vm.serializeBytes(key, "registerData", SignedDispatch.registerData(DispatchLeaves.hash(leaf)));
        vm.serializeBytes(key, "relayData", SignedDispatch.relayData(e, leaf, proof));
        vm.serializeBytes(key, "submitMessageData", SignedDispatch.submitData(e));
        vm.serializeBytes(key, "submitLeafData", SignedDispatch.submitData(e, leaf, proof));
        vm.serializeBytes32(key, "safeMessageHash", SafeHashes.messageHash(hex"abcdef", address(0x3333), 1));
        vm.serializeBytes32(key, "safeTxHash", SafeHashes.transactionHash(e.signedSafeTx.safeTx, address(0x7777), 1));
        bytes[] memory leaves = new bytes[](3);
        leaves[0] = SignedDispatch.encodeLeaf(leaf);
        leaves[1] =
            SignedDispatch.encodeLeaf(ExecutionLeaf(leaf.destination, 8, 100, 200, hex"010203", leaf.attributes));
        leaves[2] = hex"aabbcc";
        vm.serializeBytes(key, "publishData", SignedDispatch.publishData(leaves));
        vm.serializeBytes32(key, "oddRoot", SignedDispatch.root(leaves));
        SafeBatchExecutor.SafeExecution[] memory entries = new SafeBatchExecutor.SafeExecution[](1);
        SafeTx memory t = e.signedSafeTx.safeTx;
        entries[0] = SafeBatchExecutor.SafeExecution(
            ISafeExec(address(0x7777)),
            t.to,
            t.value,
            t.data,
            t.operation,
            t.safeTxGas,
            t.baseGas,
            t.gasPrice,
            t.gasToken,
            payable(t.refundReceiver),
            e.signedSafeTx.signatures
        );
        string memory json =
            vm.serializeBytes(key, "safeBatchData", abi.encodeCall(SafeBatchExecutor.execute, (entries)));
        vm.writeFile("vectors/signed.json", json);
    }

    /// @dev The first protocol #109 receiver vector: one root Safe with three EOA owners.
    function test_bootstrapBodyMatchesProtocolVector() public view {
        string memory json = vm.readFile("vectors/authority.json");
        SafeOwner[] memory owners = new SafeOwner[](3);
        owners[0] = SafeOwner(0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf, 0);
        owners[1] = SafeOwner(0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF, 0);
        owners[2] = SafeOwner(0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69, 0);
        AuthorityGraph memory g;
        g.nodes = new AuthorityNode[](1);
        g.nodes[0] = AuthorityNode(SafeAuthorityRecord(vm.parseJsonAddress(json, ".single.sourceSafe"), 2, owners), 0);
        bytes memory body = SignedDispatch.bootstrapBody(
            vm.parseJsonAddress(json, ".single.guard"), vm.parseJsonBytes32(json, ".single.updateHead"), g, emptySetup()
        );
        assertEq(body, vm.parseJsonBytes(json, ".single.encoded"));
    }

    function test_bootstrapDataWrapsPayloadForDestination() public pure {
        bytes memory body = SignedDispatch.bootstrapBody(GUARD, HEAD, graph(), emptySetup());
        bytes[] memory attributes = new bytes[](1);
        attributes[0] = hex"aa";
        assertEq(
            SignedDispatch.bootstrapData(BOOTSTRAP_DESTINATION, body, attributes),
            abi.encodeCall(
                ISignedTransmitter.bootstrap, (Payload.encodeBootstrap(BOOTSTRAP_DESTINATION, body), attributes)
            )
        );
        SignedBootstrap memory decoded = abi.decode(body, (SignedBootstrap));
        assertEq(decoded.guard, GUARD);
        assertEq(decoded.updateHead, HEAD);
        assertEq(decoded.authority, abi.encode(graph()));
        assertEq(decoded.setupCalls, emptySetup());
    }

    function testFuzz_leafPublicationAndReplayIdentity(uint256 nonce, bytes memory attributes) public pure {
        ExecutionLeaf memory leaf = execution();
        leaf.nonce = nonce;
        assertEq(DispatchLeaves.hash(leaf), keccak256(abi.encode(keccak256(SignedDispatch.encodeLeaf(leaf)))));
        bytes32 id = DispatchLeaves.executionId(leaf);
        leaf.attributes[0] = attributes;
        assertEq(DispatchLeaves.executionId(leaf), id);
    }

    function test_oddNodeProofAndSingleLeaf() public pure {
        bytes[] memory leaves = new bytes[](3);
        leaves[0] = hex"01";
        leaves[1] = hex"02";
        leaves[2] = hex"03";
        bytes32 a = keccak256(abi.encode(keccak256(leaves[0])));
        bytes32 b = keccak256(abi.encode(keccak256(leaves[1])));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        DispatchLeaves.requireProof(proof, SignedDispatch.root(leaves), keccak256(abi.encode(keccak256(leaves[2]))));
        leaves = new bytes[](1);
        leaves[0] = hex"01";
        assertEq(SignedDispatch.root(leaves), a);
    }

    function test_emptyTreeReverts() public {
        vm.expectRevert(SignedDispatch.NoLeaves.selector);
        this.emptyTree();
    }

    function emptyTree() external pure {
        SignedDispatch.root(new bytes[](0));
    }
}
