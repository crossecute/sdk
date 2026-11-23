// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ExecutionLeaf} from "@crossecute/protocol/messaging/signed/types/SignedDispatchTypes.sol";
import {DispatchLeaves} from "@crossecute/protocol/messaging/signed/DispatchLeaves.sol";
import {SignedDispatch} from "./SignedDispatch.sol";

/// @notice The receiver's `nextNonce` for `destination` when the plan was built.
struct ReceiverNonce {
    bytes destination;
    uint256 nextNonce;
}

struct MerkleEntry {
    ExecutionLeaf leaf;
    bytes32 hash;
    bytes32[] proof;
}

/// @notice A root with the leaves, hashes and proofs under it. `leaves` is in publication order, which
///         defines the tree.
struct MerklePackage {
    bytes32 root;
    ReceiverNonce[] receiverNonces;
    MerkleEntry[] leaves;
}

/// @title MerklePackages
/// @notice Builds the package the TypeScript SDK's `buildMerklePackage` builds, with the same plan
///         rules, so a Foundry script can draft what signers review before the owner Safe signs
///         `registerRoot`.
/// @dev Checks are quadratic in the leaf count and meant for scripts, not on-chain use.
library MerklePackages {
    /// Layout version of the JSON file; `MERKLE_PACKAGE_VERSION` in `ts/src/merkle.ts` must match.
    uint256 internal constant VERSION = 1;

    error DuplicateLeaf(uint256 index);
    error DuplicateReceiverNonce(uint256 index);
    error MissingReceiverNonce(uint256 leafIndex);
    error StaleNonce(uint256 leafIndex, uint256 nonce, uint256 nextNonce);
    error ConflictingNonce(uint256 leafIndex, uint256 otherIndex);
    error UnusedReceiverNonce(uint256 index);

    /// @notice Reverts on a plan the receiver would refuse or that wastes a root: a duplicate leaf, two
    ///         different batches at one receiver nonce, a nonce below the observed `nextNonce`, or
    ///         receiver nonces that are missing, repeated or unused. The same batch at one nonce with
    ///         different attributes is allowed, since the receiver records it by execution ID.
    function requireMerklePlan(ExecutionLeaf[] memory leaves, ReceiverNonce[] memory receiverNonces) internal pure {
        _leafHashes(leaves, receiverNonces);
    }

    /// @notice Checks the plan, then returns the root and each leaf's hash and proof, in order.
    function build(ExecutionLeaf[] memory leaves, ReceiverNonce[] memory receiverNonces)
        internal
        pure
        returns (MerklePackage memory pkg)
    {
        bytes32[] memory hashes = _leafHashes(leaves, receiverNonces);
        pkg.receiverNonces = receiverNonces;
        pkg.leaves = new MerkleEntry[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            // `treeOfHashes` overwrites its input level by level.
            bytes32[] memory level = new bytes32[](hashes.length);
            for (uint256 j; j < level.length; ++j) {
                level[j] = hashes[j];
            }
            bytes32[] memory siblings;
            (pkg.root, siblings) = SignedDispatch.treeOfHashes(level, i);
            pkg.leaves[i] = MerkleEntry(leaves[i], hashes[i], siblings);
        }
    }

    /// @notice `publishLeaves` calldata for the guard, carrying the encoded leaves in package order.
    function publishLeavesCalldata(MerklePackage memory pkg) internal pure returns (bytes memory) {
        bytes[] memory encoded = new bytes[](pkg.leaves.length);
        for (uint256 i; i < encoded.length; ++i) {
            encoded[i] = SignedDispatch.encodeLeaf(pkg.leaves[i].leaf);
        }
        return SignedDispatch.publishLeavesCalldata(encoded);
    }

    /// @notice `registerRoot` calldata for the owner Safe's signed transaction.
    function registerRootCalldata(MerklePackage memory pkg) internal pure returns (bytes memory) {
        return SignedDispatch.registerRootCalldata(pkg.root);
    }

    function _leafHashes(ExecutionLeaf[] memory leaves, ReceiverNonce[] memory receiverNonces)
        private
        pure
        returns (bytes32[] memory hashes)
    {
        if (leaves.length == 0) revert SignedDispatch.NoLeaves();
        bytes32[] memory keys = _receiverKeys(receiverNonces);
        bool[] memory served = new bool[](keys.length);
        hashes = new bytes32[](leaves.length);
        bytes32[] memory slots = new bytes32[](leaves.length);
        bytes32[] memory ids = new bytes32[](leaves.length);

        for (uint256 i; i < leaves.length; ++i) {
            hashes[i] = DispatchLeaves.hash(leaves[i]);
            for (uint256 j; j < i; ++j) {
                if (hashes[j] == hashes[i]) revert DuplicateLeaf(i);
            }

            bytes32 key = keccak256(leaves[i].destination);
            uint256 r = _indexOf(keys, key);
            if (r == keys.length) revert MissingReceiverNonce(i);
            served[r] = true;
            if (leaves[i].nonce < receiverNonces[r].nextNonce) {
                revert StaleNonce(i, leaves[i].nonce, receiverNonces[r].nextNonce);
            }

            slots[i] = keccak256(abi.encode(key, leaves[i].nonce));
            ids[i] = DispatchLeaves.executionId(leaves[i]);
            for (uint256 j; j < i; ++j) {
                if (slots[j] == slots[i] && ids[j] != ids[i]) revert ConflictingNonce(i, j);
            }
        }

        for (uint256 r; r < served.length; ++r) {
            if (!served[r]) revert UnusedReceiverNonce(r);
        }
    }

    function _receiverKeys(ReceiverNonce[] memory receiverNonces) private pure returns (bytes32[] memory keys) {
        keys = new bytes32[](receiverNonces.length);
        for (uint256 i; i < keys.length; ++i) {
            keys[i] = keccak256(receiverNonces[i].destination);
            if (_indexOf(keys, keys[i]) != i) revert DuplicateReceiverNonce(i);
        }
    }

    /// @dev The first index of `key` in `keys`, or `keys.length`. Entries after the one being filled in
    ///      `_receiverKeys` are zero, so a real key never matches them.
    function _indexOf(bytes32[] memory keys, bytes32 key) private pure returns (uint256 i) {
        for (; i < keys.length; ++i) {
            if (keys[i] == key) return i;
        }
    }
}
