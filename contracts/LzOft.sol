// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILzOftConduitFactory} from "@crossecute/protocol/protocols/layerzero/ILzOftConduitFactory.sol";
import {LzOftConduitAddress} from "@crossecute/protocol/protocols/layerzero/LzOftConduitAddress.sol";

/// @notice Foundry builders for protocol's `layerzero-oft` binding: the options attribute, the destination
///         leaves and root a conduit's address binds, `createTransmitter` calldata and address prediction.
///         Plain and signed conduits are created identically; the factory fixes the mode from the owner Safe's
///         guard at creation. Nothing here reads chain state: peers, eids and the guard are not checked.
library LzOft {
    /// @dev `LzMessage.OPTIONS_ATTRIBUTE`.
    // forge-lint: disable-next-line(unsafe-typecast) a selector is the hash's first 4 bytes
    bytes4 internal constant OPTIONS_ATTRIBUTE = bytes4(keccak256("crossecute.lz.options"));

    /// @dev `keccak256` of `Proxy`'s initcode at the pinned protocol release, which a conduit's CREATE2 address
    ///      hashes. `predictConduit` takes the hash as an argument; the deployed factory's `PROXY_INIT_CODE_HASH()`
    ///      is the value to pass. test/LzOft.t.sol compares this with vectors/lzoft-protocol.json, which
    ///      scripts/sync-protocol.py derives from protocol.
    bytes32 internal constant PROXY_INIT_CODE_HASH = 0x825940f5905807e2b38780497d34b22480ffdb4cd09cdfd4720a194910beada6;

    error EmptyOptions();

    /// @notice The only attribute a `layerzero-oft` conduit accepts: `rawOptions` replace the default lzCompose
    ///         option whole, so they must carry the compose gas the destination needs.
    /// @dev Protocol reads a selector-only attribute as present with empty options (`ProviderAttribute.body`), not
    ///      as "use the defaults", which would send with no lzCompose option; so empty options revert here.
    function optionsAttribute(bytes memory rawOptions) internal pure returns (bytes memory) {
        if (rawOptions.length == 0) revert EmptyOptions();
        return abi.encodePacked(OPTIONS_ATTRIBUTE, rawOptions);
    }

    /// @notice The leaf hash of a destination record.
    function leafHash(ILzOftConduitFactory.Destination memory destination) internal pure returns (bytes32) {
        return LzOftConduitAddress.leafHash(destination);
    }

    /// @notice Offline validation before the home chain is known. A zero chain key is invalid.
    function requireLeaves(ILzOftConduitFactory.Destination[] memory destinations) internal pure {
        LzOftConduitAddress.requireDestinations(destinations, bytes32(0), 0);
    }

    /// @notice Offline validation for the given home chain and endpoint.
    function requireLeaves(ILzOftConduitFactory.Destination[] memory destinations, bytes32 homeChainKey, uint32 homeEid)
        internal
        pure
    {
        LzOftConduitAddress.requireDestinations(destinations, homeChainKey, homeEid);
    }

    /// @notice The root of destinations in ascending chain-key order, before the home chain is known.
    function root(ILzOftConduitFactory.Destination[] memory destinations) internal pure returns (bytes32) {
        return LzOftConduitAddress.destRoot(destinations, bytes32(0), 0);
    }

    /// @notice The root with the checks that need the home chain's key and eid.
    function root(ILzOftConduitFactory.Destination[] memory destinations, bytes32 homeChainKey, uint32 homeEid)
        internal
        pure
        returns (bytes32)
    {
        return LzOftConduitAddress.destRoot(destinations, homeChainKey, homeEid);
    }

    /// @notice `createTransmitter` calldata. The owner Safe sends it as a CALL: the owner is `msg.sender`.
    function createTransmitterCalldata(
        bytes32 salt,
        address homeOft,
        ILzOftConduitFactory.Destination[] memory destinations
    ) internal pure returns (bytes memory) {
        requireLeaves(destinations);
        return abi.encodeCall(ILzOftConduitFactory.createTransmitter, (salt, homeOft, destinations));
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
        return LzOftConduitAddress.conduitSalt(owner, salt, homeChainKey, homeEid, homeOft, destRoot);
    }

    /// @notice `LzOftConduitFactory.predictConduit` for the factory at `factory`, hashing `proxyInitCodeHash`, which
    ///         is the deployed factory's `PROXY_INIT_CODE_HASH()`. The receiver is at the same address on every
    ///         destination.
    function predictConduit(
        address factory,
        address owner,
        bytes32 salt,
        bytes32 homeChainKey,
        uint32 homeEid,
        address homeOft,
        bytes32 destRoot,
        bytes32 proxyInitCodeHash
    ) internal pure returns (address) {
        return LzOftConduitAddress.predictConduit(
            factory, proxyInitCodeHash, owner, salt, homeChainKey, homeEid, homeOft, destRoot
        );
    }
}
