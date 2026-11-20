// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {LzDvn} from "@crossecute/sdk/LzDvn.sol";
import {MockTransceiver, MockTransmitter} from "./MockConduit.sol";
import {MockLzTransmitter} from "./MockLz.sol";

/// @notice `LzDvn` against Ethereum's real endpoint and send library, 2026-11-20: Fraxtal's
///         default send ULN requires the dead DVN and Arbitrum's does not. Skipped without
///         `ETH_RPC_URL`; reads only, so a public RPC is enough. `ETH_FORK_BLOCK` pins a block.
contract LzDvnForkTest is Test {
    address constant ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    uint256 constant FRAXTAL = 252;
    uint256 constant ARBITRUM = 42161;

    MockTransceiver transceiver;
    MockLzTransmitter conduit;

    function _fork() internal {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        uint256 blockNumber = vm.envOr("ETH_FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);
        transceiver = new MockTransceiver(address(0xBEEF));
        transceiver.setMessageProvider(LzDvn.PROVIDER);
        transceiver.setProviderId(ChainKey.forEvm(FRAXTAL), 30255);
        transceiver.setProviderId(ChainKey.forEvm(ARBITRUM), 30110);
        conduit = new MockLzTransmitter(address(0xA11CE), address(transceiver), ENDPOINT);
    }

    function test_fraxtalsDefaultRequiresTheDeadDvn() public {
        _fork();
        (bool dead, uint32 eid) = LzDvn.requiresDeadDvn(address(transceiver), address(conduit), FRAXTAL);
        assertTrue(dead);
        assertEq(eid, 30255);
    }

    function test_arbitrumsDefaultDoesNot() public {
        _fork();
        (bool dead,) = LzDvn.requiresDeadDvn(address(transceiver), address(conduit), ARBITRUM);
        assertFalse(dead);
    }
}
