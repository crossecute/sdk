// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {SignedDispatch} from "./SignedDispatch.sol";

/// @notice The factory entry point a `layerzero-oft` conduit is created through; protocol revision 3169f8c.
///         The factory is `LzOftConduitFactory`, one address on every chain.
interface ILzOftConduitFactory {
    struct Leaf {
        bytes32 chainKey;
        uint32 eid;
        address oft;
    }

    function createTransmitter(bytes32 salt, address homeOft, Leaf[] calldata leaves) external returns (address);
}

/// @notice Foundry builders for protocol's `layerzero-oft` binding: the options attribute, the destination
///         leaves and root a conduit's address binds, `createTransmitter` calldata and address prediction.
///         Plain and signed conduits are created identically; the factory fixes the mode from the owner Safe's
///         guard at creation. Nothing here reads chain state: peers, eids and the guard are not checked.
library LzOft {
    /// @dev `LzMessage.OPTIONS_ATTRIBUTE`.
    // forge-lint: disable-next-line(unsafe-typecast) a selector is the hash's first 4 bytes
    bytes4 internal constant OPTIONS_ATTRIBUTE = bytes4(keccak256("crossecute.lz.options"));

    /// @dev `keccak256` of `Proxy`'s initcode at the pinned protocol revision, which a conduit's CREATE2 address
    ///      hashes. The deployed factory's `PROXY_INIT_CODE_HASH()` is authoritative. test/LzOft.t.sol compares
    ///      this with vectors/lzoft-protocol.json, which scripts/sync-protocol135.py derives from protocol.
    bytes32 internal constant PROXY_INIT_CODE_HASH = 0x825940f5905807e2b38780497d34b22480ffdb4cd09cdfd4720a194910beada6;

    error NoDestinations();
    /// @dev Strictly ascending `chainKey` order, which also refuses a repeat; the factory's `LeavesNotSorted`.
    error LeavesNotSorted(uint256 index);
    /// @dev A zero eid or OFT, or, given a home, the home's own chain key or eid; the factory's `BadLeaf`.
    error BadLeaf(uint256 index);

    /// @notice The only attribute a `layerzero-oft` conduit accepts: `rawOptions` replace the default lzCompose
    ///         option whole, so they must carry the compose gas the destination needs.
    function optionsAttribute(bytes memory rawOptions) internal pure returns (bytes memory) {
        return abi.encodePacked(OPTIONS_ATTRIBUTE, rawOptions);
    }

    /// @notice `LzOftMessage.leaf`. Hashed twice, like every leaf here.
    function leafHash(ILzOftConduitFactory.Leaf memory leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(abi.encode(leaf.chainKey, leaf.eid, leaf.oft))));
    }

    /// @notice Offline form of the factory's `_checkLeaves`, in its order, without the checks that read the home
    ///         OFT's peers. Reverts as the factory would.
    function checkLeaves(ILzOftConduitFactory.Leaf[] memory leaves) internal pure {
        _check(leaves, false, 0, 0);
    }

    /// @notice `checkLeaves`, and that no leaf names the home chain or the home's eid.
    function checkLeaves(ILzOftConduitFactory.Leaf[] memory leaves, bytes32 homeChainKey, uint32 homeEid)
        internal
        pure
    {
        _check(leaves, true, homeChainKey, homeEid);
    }

    function _check(ILzOftConduitFactory.Leaf[] memory leaves, bool hasHome, bytes32 homeChainKey, uint32 homeEid)
        private
        pure
    {
        if (leaves.length == 0) revert NoDestinations();
        for (uint256 i; i < leaves.length; ++i) {
            ILzOftConduitFactory.Leaf memory l = leaves[i];
            if (i != 0 && l.chainKey <= leaves[i - 1].chainKey) revert LeavesNotSorted(i);
            if (l.eid == 0 || l.oft == address(0) || (hasHome && (l.chainKey == homeChainKey || l.eid == homeEid))) {
                revert BadLeaf(i);
            }
        }
    }

    /// @notice `LzOftMessage.root` over `leaves`, which must be in ascending `chainKey` order: the
    ///         `destRoot` the factory computes from the same list and binds into the conduit's address.
    function root(ILzOftConduitFactory.Leaf[] memory leaves) internal pure returns (bytes32 destRoot) {
        checkLeaves(leaves);
        bytes32[] memory hashes = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            hashes[i] = leafHash(leaves[i]);
        }
        (destRoot,) = SignedDispatch.treeOfHashes(hashes, 0);
    }

    /// @notice `root`, with the checks that need the home chain's key and eid.
    function root(ILzOftConduitFactory.Leaf[] memory leaves, bytes32 homeChainKey, uint32 homeEid)
        internal
        pure
        returns (bytes32)
    {
        checkLeaves(leaves, homeChainKey, homeEid);
        return root(leaves);
    }

    /// @notice `createTransmitter` calldata. The owner Safe sends it as a CALL: the owner is `msg.sender`.
    function createTransmitterData(bytes32 salt, address homeOft, ILzOftConduitFactory.Leaf[] memory leaves)
        internal
        pure
        returns (bytes memory)
    {
        checkLeaves(leaves);
        return abi.encodeCall(ILzOftConduitFactory.createTransmitter, (salt, homeOft, leaves));
    }

    /// @notice `LzOftConduitFactory.conduitSalt`.
    function conduitSalt(
        address owner,
        bytes32 salt,
        bytes32 homeChainKey,
        uint32 homeEid,
        address homeOft,
        bytes32 destRoot
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt, homeChainKey, homeEid, homeOft, destRoot));
    }

    /// @notice `LzOftConduitFactory.predictConduit` for the factory at `factory`, with the pinned initcode hash.
    ///         The receiver is at the same address on every destination.
    function predictConduit(
        address factory,
        address owner,
        bytes32 salt,
        bytes32 homeChainKey,
        uint32 homeEid,
        address homeOft,
        bytes32 destRoot
    ) internal pure returns (address) {
        return Create2.computeAddress(
            conduitSalt(owner, salt, homeChainKey, homeEid, homeOft, destRoot), PROXY_INIT_CODE_HASH, factory
        );
    }
}
