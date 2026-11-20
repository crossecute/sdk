// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {ExecutionLeaf} from "./vendor/protocol135/SignedDispatchTypes.sol";
import {CrossecuteScript} from "./CrossecuteScript.sol";
import {MerklePackage, ReceiverNonce, MerklePackages} from "./MerklePackage.sol";
import {MerklePackageJson} from "./MerklePackageJson.sol";

/// @notice The signed receiver's next execution nonce.
interface IReceiverNonce {
    function nextNonce() external view returns (uint256);
}

/// @title MerklePackageScript
/// @notice Base for scripts that draft the Merkle package behind a signed `registerRoot`. Like
///         `CrossecuteScript`, a script runs on the home chain, forks each destination, and adds batches;
///         each becomes an execution leaf for the conduit's receiver there. The receiver comes from the
///         transmitter, its `nextNonce` is read from the destination fork, and the leaf's calls are
///         simulated as the receiver. `_merklePackage` checks the plan and builds the package, and
///         `_writeMerklePackage` writes the JSON the other owners review and `crossecute` reads.
/// @dev Leaf order is publication order and defines the tree. A destination whose receiver is not yet
///      deployed starts at nonce 0. EVM destinations only: build other leaves with `MerklePackages`.
abstract contract MerklePackageScript is CrossecuteScript {
    ExecutionLeaf[] private _leaves;
    ReceiverNonce[] private _receiverNonces;
    mapping(uint256 chainId => uint256 indexPlusOne) private _observed;
    mapping(uint256 chainId => uint256 nonce) private _nextFree;

    error ReceiverNonceUnreadable(uint256 chainId, address receiver);

    /// @notice Queues `calls` for the receiver on `chainId` at the next free nonce, after simulating
    ///         them as the receiver. Empty `attributes` take the provider's default gas.
    function _addLeaf(
        uint256 chainId,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) internal returns (uint256 nonce, uint256 gasUsed) {
        (address receiver, uint256 index) = _observeReceiver(chainId);
        nonce = _nextFree[chainId];
        gasUsed = _queue(chainId, receiver, index, nonce, validAfter, deadline, calls, attributes);
    }

    /// @notice As above at `nonce`, for the same batch under other attributes. Later free nonces follow it.
    ///         `_merklePackage` rejects a nonce the receiver has passed and one that holds another batch.
    function _addLeaf(
        uint256 chainId,
        uint256 nonce,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) internal returns (uint256 gasUsed) {
        (address receiver, uint256 index) = _observeReceiver(chainId);
        gasUsed = _queue(chainId, receiver, index, nonce, validAfter, deadline, calls, attributes);
    }

    /// @notice Checks the queued plan and builds its package. Reverts with a `MerklePackages` error on a
    ///         plan the receiver would refuse.
    function _merklePackage() internal view returns (MerklePackage memory) {
        return MerklePackages.build(_leaves, _receiverNonces);
    }

    function _writeMerklePackage(MerklePackage memory pkg, string memory path) internal {
        vm.writeFile(path, MerklePackageJson.toJson(pkg));
    }

    function _queue(
        uint256 chainId,
        address receiver,
        uint256 index,
        uint256 nonce,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) private returns (uint256 gasUsed) {
        gasUsed = _simulate(chainId, receiver, calls);
        _selectHome();
        _leaves.push(
            ExecutionLeaf({
                destination: _receiverNonces[index].destination,
                nonce: nonce,
                validAfter: validAfter,
                deadline: deadline,
                calls: Payload.encodeCalls(calls),
                attributes: attributes
            })
        );
        if (nonce >= _nextFree[chainId]) _nextFree[chainId] = nonce + 1;
    }

    /// @dev Resolves the receiver through the transmitter and records its `nextNonce` the first time the
    ///      chain is used. Later leaves reuse that observation, so one package never mixes blocks.
    function _observeReceiver(uint256 chainId) private returns (address receiver, uint256 index) {
        receiver = _receiverOn(chainId);
        uint256 slot = _observed[chainId];
        if (slot != 0) return (receiver, slot - 1);

        uint256 next;
        _selectDestination(chainId);
        if (receiver.code.length == 0) {
            console2.log("receiver %s on chain %s is not deployed: nonces start at 0", receiver, chainId);
        } else {
            (bool ok, bytes memory ret) = receiver.staticcall(abi.encodeCall(IReceiverNonce.nextNonce, ()));
            if (!ok || ret.length != 32) revert ReceiverNonceUnreadable(chainId, receiver);
            next = abi.decode(ret, (uint256));
        }
        _selectHome();

        index = _receiverNonces.length;
        _receiverNonces.push(ReceiverNonce(Erc7930.encodeEvm(chainId, receiver), next));
        _observed[chainId] = index + 1;
        _nextFree[chainId] = next;
    }
}
