// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTx} from "./vendor/protocol135/ICrossecuteGuard.sol";

import {Call} from "@crossecute/protocol/messaging/Call.sol";

/// @notice A call the conduit's owner makes on the home chain.
struct HomeCall {
    address to;
    uint256 value;
    bytes data;
}

/// @notice One ordered batch for the conduit's receiver on one EVM destination, as simulated.
struct Batch {
    uint256 chainId;
    address receiver;
    Call[] calls;
    bytes[] attributes;
    /// Gas the calls used in simulation, excluding the receiver's own delivery overhead.
    uint256 gasUsed;
    /// Whether the batch is sent as the destination's bootstrap rather than a message.
    bool bootstrap;
}

/// @notice What the owner signs or sends on the home chain, and the batches it carries.
struct Plan {
    uint256 homeChainId;
    address owner;
    address transmitter;
    /// The quoted total of every call's fee. `calls[0].value` tops the transmitter up to cover
    /// it with the script's buffer.
    uint256 fee;
    HomeCall[] calls;
    Batch[] batches;
}
