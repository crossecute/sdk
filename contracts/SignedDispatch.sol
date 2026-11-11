// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTx} from "./Types.sol";
import {DispatchLeaves} from "./vendor/protocol135/DispatchLeaves.sol";
import {
    ExecutionLeaf,
    BootstrapLeaf,
    SafeTxEvidence,
    SignedBootstrap
} from "./vendor/protocol135/SignedDispatchTypes.sol";
import {ISignedTransmitter} from "./vendor/protocol135/ISignedTransmitter.sol";
import {ISignedReceiver} from "./vendor/protocol135/ISignedReceiver.sol";
import {ICrossecuteGuard} from "./vendor/protocol135/ICrossecuteGuard.sol";
import {SafeAuthorityRecord} from "./vendor/protocol135/SafeAuthorityTypes.sol";
import {IERC7786GatewaySource} from "@crossecute/protocol/messaging/IErc7786.sol";

/// @notice Foundry builders for protocol #135. Does not collect or authenticate signatures,
///         simulate provider delivery, or predict receiver addresses from local initcode.
/// @dev Import leaf/evidence types from vendor/protocol135/SignedDispatchTypes.sol until
///      a protocol package containing these interfaces is published.
library SignedDispatch {
    error NoLeaves();
    error EmptySignedPayload();

    /// @notice Fields for guard publication. abi.encode(leaf) would add a tuple offset.
    function encodeLeaf(ExecutionLeaf memory leaf) internal pure returns (bytes memory) {
        return abi.encode(leaf.destination, leaf.nonce, leaf.validAfter, leaf.deadline, leaf.calls, leaf.attributes);
    }

    function encodeLeaf(BootstrapLeaf memory leaf) internal pure returns (bytes memory) {
        return abi.encode(leaf.destination, leaf.validAfter, leaf.deadline, leaf.setupCalls);
    }

    /// @notice Ordered tree with sorted sibling hashing and odd-node promotion, matching the guard.
    function root(bytes[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) revert NoLeaves();
        bytes32[] memory level = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            level[i] = keccak256(abi.encode(keccak256(leaves[i])));
        }
        uint256 count = level.length;
        while (count > 1) {
            for (uint256 i; i < count; i += 2) {
                if (i + 1 == count) {
                    level[i / 2] = level[i];
                } else {
                    (bytes32 a, bytes32 b) = (level[i], level[i + 1]);
                    level[i / 2] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
                }
            }
            count = (count + 1) / 2;
        }
        return level[0];
    }

    function sendData(bytes memory destination, bytes memory calls, bytes[] memory attributes)
        internal
        pure
        returns (bytes memory)
    {
        if (calls.length == 0) revert EmptySignedPayload();
        return abi.encodeCall(IERC7786GatewaySource.sendMessage, (destination, calls, attributes));
    }

    function bootstrapData(
        bytes32 treeRoot,
        BootstrapLeaf memory leaf,
        bytes32[] memory proof,
        bytes[] memory attributes
    ) internal pure returns (bytes memory) {
        DispatchLeaves.requireProof(proof, treeRoot, DispatchLeaves.hash(leaf));
        return abi.encodeCall(ISignedTransmitter.bootstrap, (abi.encode(treeRoot, uint256(0), leaf, proof), attributes));
    }

    function registerData(bytes32 treeRoot) internal pure returns (bytes memory) {
        return abi.encodeCall(ISignedTransmitter.registerRoot, (treeRoot));
    }

    function publishData(bytes[] memory leaves) internal pure returns (bytes memory) {
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
        return abi.encode(uint256(1), evidence);
    }

    function merkleWire(SafeTxEvidence memory evidence, ExecutionLeaf memory leaf, bytes32[] memory proof)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(uint256(2), evidence, leaf, proof);
    }

    function bootstrapBody(SafeTxEvidence memory evidence, SafeAuthorityRecord[] memory records)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(SignedBootstrap(evidence, records));
    }

    function relayData(SafeTxEvidence memory evidence, ExecutionLeaf memory leaf, bytes32[] memory proof)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISignedTransmitter.relayLeaf, (evidence, leaf, proof));
    }

    function submitData(SafeTxEvidence memory evidence) internal pure returns (bytes memory) {
        return abi.encodeCall(ISignedReceiver.submitMessage, (evidence));
    }

    function submitData(SafeTxEvidence memory evidence, ExecutionLeaf memory leaf, bytes32[] memory proof)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISignedReceiver.submitLeaf, (evidence, leaf, proof));
    }
}
