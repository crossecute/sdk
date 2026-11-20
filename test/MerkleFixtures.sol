// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignedDispatch} from "../contracts/SignedDispatch.sol";
import {ReceiverNonce} from "../contracts/MerklePackage.sol";
import {ExecutionLeaf} from "../contracts/vendor/protocol135/SignedDispatchTypes.sol";

/// @dev Leaves that `ts/test/merkle.test.ts` builds from the same definitions. `guard` leaves are those of
///      the protocol guard's `test_publish_matchesOffchainVector`.
abstract contract MerkleFixtures {
    bytes constant GUARD_DESTINATION = hex"000100000114";

    function guardExecutionLeaves(uint256 count) internal pure returns (ExecutionLeaf[] memory leaves) {
        leaves = new ExecutionLeaf[](count);
        bytes[] memory attributes = new bytes[](1);
        attributes[0] = hex"aa";
        for (uint256 i; i < count; ++i) {
            leaves[i] = ExecutionLeaf(GUARD_DESTINATION, i, 0, 1000, hex"c0de", attributes);
        }
    }

    function guardReceiverNonces() internal pure returns (ReceiverNonce[] memory nonces) {
        nonces = new ReceiverNonce[](1);
        nonces[0] = ReceiverNonce(GUARD_DESTINATION, 0);
    }

    function multiExecutionLeaves() internal pure returns (ExecutionLeaf[] memory leaves) {
        bytes[] memory attributes = new bytes[](0);
        leaves = new ExecutionLeaf[](4);
        leaves[0] = ExecutionLeaf(hex"0001000001aa", 3, 10, 20, hex"01", attributes);
        leaves[1] = ExecutionLeaf(hex"0001000001bb", 0, 10, 20, hex"02", attributes);
        leaves[2] = ExecutionLeaf(hex"0001000001aa", 4, 10, 20, hex"03", attributes);
        leaves[3] = ExecutionLeaf(hex"0001000001cc", 0, 10, 20, hex"04", attributes);
    }

    function multiReceiverNonces() internal pure returns (ReceiverNonce[] memory nonces) {
        nonces = new ReceiverNonce[](3);
        nonces[0] = ReceiverNonce(hex"0001000001aa", 3);
        nonces[1] = ReceiverNonce(hex"0001000001bb", 0);
        nonces[2] = ReceiverNonce(hex"0001000001cc", 0);
    }

    function encoded(ExecutionLeaf[] memory leaves) internal pure returns (bytes[] memory out) {
        out = new bytes[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            out[i] = SignedDispatch.encodeLeaf(leaves[i]);
        }
    }
}
