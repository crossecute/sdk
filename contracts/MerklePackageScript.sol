// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {ExecutionLeaf} from "./vendor/protocol135/SignedDispatchTypes.sol";
import {MerklePackage, ReceiverNonce, MerklePackages} from "./MerklePackage.sol";
import {MerklePackageJson} from "./MerklePackageJson.sol";

/// @title MerklePackageScript
/// @notice Base for scripts that draft the Merkle package behind a signed `registerRoot`. A script queues
///         execution leaves and the receivers' observed `nextNonce`, builds the package, and writes the
///         JSON the other owners review and `crossecute` reads.
/// @dev Does not read receiver state or simulate the calls: pass the `nextNonce` observed at the pinned
///      block, and simulate the batches separately. Leaf order is publication order and defines the tree.
abstract contract MerklePackageScript is Script {
    ExecutionLeaf[] private _leaves;
    ReceiverNonce[] private _receiverNonces;

    function _addLeaf(ExecutionLeaf memory leaf) internal {
        _leaves.push(leaf);
    }

    /// @notice Queues a batch of EVM calls for the receiver at `receiver` on `chainId`.
    function _addLeaf(
        uint256 chainId,
        address receiver,
        uint256 nonce,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) internal {
        _leaves.push(
            ExecutionLeaf({
                destination: Erc7930.encodeEvm(chainId, receiver),
                nonce: nonce,
                validAfter: validAfter,
                deadline: deadline,
                calls: Payload.encodeCalls(calls),
                attributes: attributes
            })
        );
    }

    /// @notice Records the receiver's `nextNonce` as observed when the plan was built.
    function _addReceiverNonce(bytes memory destination, uint256 nextNonce) internal {
        _receiverNonces.push(ReceiverNonce(destination, nextNonce));
    }

    function _addReceiverNonce(uint256 chainId, address receiver, uint256 nextNonce) internal {
        _addReceiverNonce(Erc7930.encodeEvm(chainId, receiver), nextNonce);
    }

    /// @notice Checks the queued plan and builds its package. Reverts with a `MerklePackages` error on a
    ///         plan the receiver would refuse.
    function _merklePackage() internal view returns (MerklePackage memory) {
        return MerklePackages.build(_leaves, _receiverNonces);
    }

    function _writeMerklePackage(MerklePackage memory pkg, string memory path) internal {
        vm.writeFile(path, MerklePackageJson.toJson(pkg));
    }
}
