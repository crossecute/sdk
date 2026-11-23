// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";

interface ILzConduitTransceiver {
    function messageProvider() external view returns (bytes32);
    function providerIdFor(bytes32 chainKey) external view returns (uint256);
}

interface ILzConduit {
    function endpoint() external view returns (address);
}

interface ILzSendConfig {
    function getSendLibrary(address sender, uint32 eid) external view returns (address);
    function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory);
}

/// @title LzDvn
/// @notice Whether the OApp that sends toward a destination has a send config that requires
///         LayerZero's dead DVN, which makes every quote and send to it revert.
/// @dev LayerZero's default send ULN requires `DEAD` on pathways it has not configured (every
///      Fraxtal and zkSync pathway as of #94). A plain `layerzero` conduit's bootstrap is its
///      transceiver's send, over the transceiver's pin, which governance sets with
///      `LzTransceiver.setDvn`. A message after it is the conduit's own send, over the conduit's
///      pin, which only its owner sets with
///      `LzTransmitter.setDvn(eid, required, optional, optionalThreshold)`; the choice of DVNs is
///      theirs, so the SDK reports the pathway and does not pick a stack. The config read is the
///      endpoint's resolved one: the default until a `setDvn` pins another.
library LzDvn {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 internal constant PROVIDER = keccak256("layerzero");
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    /// @dev `UlnConfig` in LayerZero's `SendUln302`.
    struct UlnConfig {
        uint64 confirmations;
        uint8 requiredDVNCount;
        uint8 optionalDVNCount;
        uint8 optionalDVNThreshold;
        address[] requiredDVNs;
        address[] optionalDVNs;
    }

    /// @param sender The OApp that sends toward `chainId`: the transceiver for a bootstrap, the
    ///        conduit for a message.
    /// @return dead True when the conduit is plain LayerZero and `sender` requires the dead DVN
    ///         toward `chainId`. `eid` is then the destination's LayerZero id, for `setDvn`.
    function isDeadDvnRequired(address transceiver, address sender, uint256 chainId)
        internal
        view
        returns (bool dead, uint32 eid)
    {
        if (ILzConduitTransceiver(transceiver).messageProvider() != PROVIDER) return (false, 0);
        // forge-lint: disable-next-line(unsafe-typecast) LayerZero eids are uint32 and set through a uint32 setter
        eid = uint32(ILzConduitTransceiver(transceiver).providerIdFor(ChainKey.forEvm(chainId)));
        ILzSendConfig endpoint = ILzSendConfig(ILzConduit(sender).endpoint());
        address lib = endpoint.getSendLibrary(sender, eid);
        UlnConfig memory uln = abi.decode(endpoint.getConfig(sender, lib, eid, CONFIG_TYPE_ULN), (UlnConfig));
        for (uint256 i; i < uln.requiredDVNs.length; ++i) {
            if (uln.requiredDVNs[i] == DEAD) return (true, eid);
        }
    }
}
