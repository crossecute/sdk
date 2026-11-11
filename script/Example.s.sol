// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {CrossecuteScript} from "@crossecute/sdk/CrossecuteScript.sol";
import {Plan} from "@crossecute/sdk/Types.sol";

interface IOwnable {
    function transferOwnership(address newOwner) external;
}

/// @notice Moves ownership of one contract on each of two destinations to `NEW_OWNER`, simulated
///         as the conduit's receiver there, and writes the owner Safe's transaction at
///         `SAFE_NONCE`.
/// @dev Inputs come from the environment, since Forge Attest runs a script with no arguments.
///      Runs on the home chain: forge script script/Example.s.sol --fork-url $MAINNET_RPC_URL
contract Example is CrossecuteScript {
    function run() external {
        _useHome(vm.envAddress("CROSSECUTE_REGISTRY"), vm.envAddress("CROSSECUTE_TRANSMITTER"));
        uint256 optimism = _useDestination(vm.envString("OPTIMISM_RPC_URL"));
        uint256 base = _useDestination(vm.envString("BASE_RPC_URL"));

        address newOwner = vm.envAddress("NEW_OWNER");
        _add(optimism, _transfer(vm.envAddress("OPTIMISM_TARGET"), newOwner), new bytes[](0));
        _add(base, _transfer(vm.envAddress("BASE_TARGET"), newOwner), new bytes[](0));

        Plan memory plan = _plan();
        _writePlan(plan, "out/example-plan.json");
        _writeSafeTx(plan, vm.envUint("SAFE_NONCE"), "out/example-safe-tx.json");
    }

    function _transfer(address target, address newOwner) private pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: target, value: 0, data: abi.encodeCall(IOwnable.transferOwnership, (newOwner))});
    }
}
