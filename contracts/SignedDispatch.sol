// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTx} from "./Types.sol";
import {
    ExecutionLeaf,
    SafeTxEvidence,
    SignedBootstrap,
    WIRE_STANDALONE,
    WIRE_MERKLE
} from "@crossecute/protocol/messaging/signed/types/SignedDispatchTypes.sol";
import {AuthorityGraph} from "@crossecute/protocol/messaging/authority/AuthorityGraph.sol";
import {ISignedTransmitter} from "@crossecute/protocol/messaging/outbound/ISignedTransmitter.sol";
import {ISignedReceiver} from "@crossecute/protocol/messaging/inbound/ISignedReceiver.sol";
import {ICrossecuteGuard} from "@crossecute/protocol/safe-guard/ICrossecuteGuard.sol";
import {IERC7786GatewaySource} from "@crossecute/protocol/messaging/IErc7786.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";

/// @notice Foundry builders for the protocol's signed dispatch. Does not collect or authenticate signatures,
///         simulate provider delivery, or predict receiver addresses from local initcode.
library SignedDispatch {
    error NoLeaves();
    error IndexOutOfRange();
    error EmptySignedPayload();

    /// @notice Fields for guard publication. abi.encode(leaf) would add a tuple offset.
    function encodeLeaf(ExecutionLeaf memory leaf) internal pure returns (bytes memory) {
        return abi.encode(leaf.destination, leaf.nonce, leaf.validAfter, leaf.deadline, leaf.calls, leaf.attributes);
    }

    /// @notice Ordered tree with sorted sibling hashing and odd-node promotion, matching the guard.
    function root(bytes[] memory leaves) internal pure returns (bytes32 treeRoot) {
        (treeRoot,) = tree(leaves, 0);
    }

    /// @notice Sibling hashes proving `leaves[index]`; empty for a one-leaf tree.
    function proof(bytes[] memory leaves, uint256 index) internal pure returns (bytes32[] memory siblings) {
        (, siblings) = tree(leaves, index);
    }

    function tree(bytes[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32 treeRoot, bytes32[] memory siblings)
    {
        bytes32[] memory level = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            level[i] = keccak256(abi.encode(keccak256(leaves[i])));
        }
        return treeOfHashes(level, index);
    }

    /// @notice `tree` over leaf hashes already computed. `level` is overwritten level by level, so the caller
    ///         passes a copy it no longer needs.
    function treeOfHashes(bytes32[] memory level, uint256 index)
        internal
        pure
        returns (bytes32 treeRoot, bytes32[] memory siblings)
    {
        if (level.length == 0) revert NoLeaves();
        if (index >= level.length) revert IndexOutOfRange();
        siblings = new bytes32[](64);
        uint256 depth;
        uint256 count = level.length;
        while (count > 1) {
            if ((index ^ 1) < count) siblings[depth++] = level[index ^ 1];
            for (uint256 i; i < count; i += 2) {
                if (i + 1 == count) {
                    level[i / 2] = level[i];
                } else {
                    (bytes32 a, bytes32 b) = (level[i], level[i + 1]);
                    level[i / 2] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
                }
            }
            count = (count + 1) / 2;
            index >>= 1;
        }
        assembly ("memory-safe") {
            mstore(siblings, depth)
        }
        treeRoot = level[0];
    }

    function sendMessageCalldataSigned(bytes memory destination, bytes memory calls, bytes[] memory attributes)
        internal
        pure
        returns (bytes memory)
    {
        if (calls.length == 0) revert EmptySignedPayload();
        return abi.encodeCall(IERC7786GatewaySource.sendMessage, (destination, calls, attributes));
    }

    /// @notice `bootstrap` calldata for a signed transmitter: `Payload.encodeBootstrap`'s payload naming the
    ///         destination chain, carrying `bootstrapBodySigned`.
    function bootstrapCalldataSigned(
        bytes memory destinationChainIdentifier,
        bytes memory body,
        bytes[] memory attributes
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISignedTransmitter.bootstrap, (Payload.encodeBootstrap(destinationChainIdentifier, body), attributes)
        );
    }

    function registerRootCalldata(bytes32 treeRoot) internal pure returns (bytes memory) {
        return abi.encodeCall(ISignedTransmitter.registerRoot, (treeRoot));
    }

    function publishLeavesCalldata(bytes[] memory leaves) internal pure returns (bytes memory) {
        if (leaves.length == 0) revert NoLeaves();
        return abi.encodeCall(ICrossecuteGuard.publishLeaves, (leaves));
    }

    /// @notice A signed dispatch is its own CALL at a Safe nonce, never a MultiSend delegatecall.
    /// @dev Hash/sign in the source-chain owner Safe domain using SafeTxHash / Forge Attest.
    function transaction(address transmitter, uint256 nonce, bytes memory data, uint256 value)
        internal
        pure
        returns (SafeTx memory tx_)
    {
        tx_.to = transmitter;
        tx_.nonce = nonce;
        tx_.data = data;
        tx_.value = value;
    }

    function standaloneWire(SafeTxEvidence memory evidence) internal pure returns (bytes memory) {
        return abi.encode(WIRE_STANDALONE, evidence);
    }

    function merkleWire(SafeTxEvidence memory evidence, ExecutionLeaf memory leaf, bytes32[] memory siblings)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(WIRE_MERKLE, evidence, leaf, siblings);
    }

    /// @notice `abi.encode(SignedBootstrap)` for the guard's selected `updateHead` and graph, with
    ///         `setupCalls = abi.encode(Call[])`. The graph is not validated here: the transmitter checks
    ///         it against the guard and the receiver checks its shape.
    function bootstrapBodySigned(
        address guard,
        bytes32 updateHead,
        AuthorityGraph memory graph,
        bytes memory setupCalls
    ) internal pure returns (bytes memory) {
        return abi.encode(SignedBootstrap(guard, updateHead, abi.encode(graph), setupCalls));
    }

    function relayLeafCalldata(SafeTxEvidence memory evidence, ExecutionLeaf memory leaf, bytes32[] memory siblings)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISignedTransmitter.relayLeaf, (evidence, leaf, siblings));
    }

    function submitMessageCalldata(SafeTxEvidence memory evidence) internal pure returns (bytes memory) {
        return abi.encodeCall(ISignedReceiver.submitMessage, (evidence));
    }

    function submitLeafCalldata(SafeTxEvidence memory evidence, ExecutionLeaf memory leaf, bytes32[] memory siblings)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISignedReceiver.submitLeaf, (evidence, leaf, siblings));
    }
}
