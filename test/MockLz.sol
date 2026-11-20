// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LzDvn} from "@crossecute/sdk/LzDvn.sol";
import {MockTransmitter} from "./MockConduit.sol";

/// @notice The endpoint reads `LzDvn` makes: the library a sender resolves to, and that library's
///         send ULN for a pathway, the default until `pin` stands in for the owner's `setDvn`.
contract MockLzEndpoint {
    address public constant SEND_LIBRARY = address(0x5E4D);

    mapping(uint32 => address[]) internal _defaultRequired;
    mapping(address => mapping(uint32 => address[])) internal _pinned;
    mapping(address => mapping(uint32 => bool)) internal _isPinned;

    function setDefault(uint32 eid, address[] memory required) external {
        _defaultRequired[eid] = required;
    }

    function pin(address oapp, uint32 eid, address[] memory required) external {
        _pinned[oapp][eid] = required;
        _isPinned[oapp][eid] = true;
    }

    function getSendLibrary(address, uint32) external pure returns (address) {
        return SEND_LIBRARY;
    }

    function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory) {
        require(lib == SEND_LIBRARY && configType == LzDvn.CONFIG_TYPE_ULN, "unexpected read");
        address[] memory required = _isPinned[oapp][eid] ? _pinned[oapp][eid] : _defaultRequired[eid];
        // Counts as the library stores them: 255 is "none".
        uint8 count = required.length == 0 ? 255 : uint8(required.length);
        return abi.encode(LzDvn.UlnConfig(15, count, 255, 0, required, new address[](0)));
    }
}

/// @notice A plain LayerZero conduit: the transmitter's `endpoint()` is an OApp's.
contract MockLzTransmitter is MockTransmitter {
    address public endpoint;

    constructor(address owner_, address transceiver_, address endpoint_) MockTransmitter(owner_, transceiver_) {
        endpoint = endpoint_;
    }
}
