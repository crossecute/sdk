// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignedDispatch} from "../contracts/SignedDispatch.sol";
import {SafeTx, SignedSafeTx} from "../contracts/vendor/protocol135/ICrossecuteGuard.sol";
import {SafeHashes} from "../contracts/vendor/protocol135/SafeHashes.sol";
import {DispatchLeaves} from "../contracts/vendor/protocol135/DispatchLeaves.sol";
import {
    ExecutionLeaf,
    BootstrapLeaf,
    SafeTxEvidence,
    NestedSafeApproval
} from "../contracts/vendor/protocol135/SignedDispatchTypes.sol";
import {SafeAuthorityRecord, SafeOwner} from "../contracts/vendor/protocol135/SafeAuthorityTypes.sol";
import {SafeBatchExecutor, ISafeExec} from "../contracts/vendor/protocol135/SafeBatchExecutor.sol";

contract SignedDispatchTest is Test {
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

    function records() internal pure returns (SafeAuthorityRecord[] memory r) {
        r = new SafeAuthorityRecord[](2);
        SafeOwner[] memory rootOwners = new SafeOwner[](2);
        rootOwners[0] = SafeOwner(address(0x5555), 0);
        rootOwners[1] = SafeOwner(address(0x3333), 1);
        SafeOwner[] memory childOwners = new SafeOwner[](1);
        childOwners[0] = SafeOwner(address(0x6666), 0);
        r[0] = SafeAuthorityRecord(address(0x7777), 2, rootOwners);
        r[1] = SafeAuthorityRecord(address(0x3333), 1, childOwners);
    }

    function test_writeSignedVectors() public {
        ExecutionLeaf memory leaf = execution();
        BootstrapLeaf memory boot = BootstrapLeaf(leaf.destination, 100, 200, hex"12345678");
        SafeTxEvidence memory e = fixture();
        bytes32[] memory proof = new bytes32[](0);
        bytes32 bootHash = DispatchLeaves.hash(boot);
        string memory key = "signed";
        vm.serializeBytes(key, "executionFields", SignedDispatch.encodeLeaf(leaf));
        vm.serializeBytes32(key, "executionHash", DispatchLeaves.hash(leaf));
        vm.serializeBytes32(key, "executionId", DispatchLeaves.executionId(leaf));
        vm.serializeBytes(key, "bootstrapFields", SignedDispatch.encodeLeaf(boot));
        vm.serializeBytes32(key, "bootstrapHash", bootHash);
        vm.serializeBytes(key, "bootstrapData", SignedDispatch.bootstrapData(bootHash, boot, proof, leaf.attributes));
        vm.serializeBytes(key, "sendData", SignedDispatch.sendData(leaf.destination, leaf.calls, leaf.attributes));
        vm.serializeBytes(key, "standaloneWire", SignedDispatch.standaloneWire(e));
        vm.serializeBytes(key, "merkleWire", SignedDispatch.merkleWire(e, leaf, proof));
        vm.serializeBytes(key, "bootstrapBody", SignedDispatch.bootstrapBody(e, records()));
        vm.serializeBytes(key, "registerData", SignedDispatch.registerData(bootHash));
        vm.serializeBytes(key, "relayData", SignedDispatch.relayData(e, leaf, proof));
        vm.serializeBytes(key, "submitMessageData", SignedDispatch.submitData(e));
        vm.serializeBytes(key, "submitLeafData", SignedDispatch.submitData(e, leaf, proof));
        vm.serializeBytes32(key, "graphHash", keccak256(abi.encode(records())));
        vm.serializeBytes32(
            key,
            "signedSalt",
            keccak256(
                abi.encode(address(0x7777), bytes32(uint256(1)), bytes32(uint256(2)), keccak256(abi.encode(records())))
            )
        );
        vm.serializeBytes32(key, "safeMessageHash", SafeHashes.messageHash(hex"abcdef", address(0x3333), 1));
        vm.serializeBytes32(key, "safeTxHash", SafeHashes.transactionHash(e.signedSafeTx.safeTx, address(0x7777), 1));
        bytes[] memory leaves = new bytes[](3);
        leaves[0] = SignedDispatch.encodeLeaf(leaf);
        leaves[1] = SignedDispatch.encodeLeaf(boot);
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
