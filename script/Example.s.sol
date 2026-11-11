// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {CrossecuteScript} from "@crossecute/sdk/CrossecuteScript.sol";
import {Plan} from "@crossecute/sdk/Types.sol";

interface IOwnable {
    function transferOwnership(address newOwner) external;
}

/// @notice Moves ownership of one contract on each of two destinations to the conduit's receiver
///         there, simulated as the receiver, then written for the owner Safe.
/// @dev forge script script/Example.s.sol --sig "run(address,address,address,address)" \
///      <transmitter> <target on optimism> <target on base> <new owner>
contract Example is CrossecuteScript {
    function run(address transmitter_, address opTarget, address baseTarget, address newOwner) external {
        _useHome(vm.rpcUrl("mainnet"), transmitter_);
        uint256 optimism = _useDestination(vm.rpcUrl("optimism"));
        uint256 base = _useDestination(vm.rpcUrl("base"));

        _add(optimism, _transfer(opTarget, newOwner), new bytes[](0));
        _add(base, _transfer(baseTarget, newOwner), new bytes[](0));

        Plan memory plan = _plan();
        _writeSafeBatch(plan, "out/example-safe-batch.json");
        _writePlan(plan, "out/example-plan.json");
    }

    function _transfer(address target, address newOwner) private pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: target, value: 0, data: abi.encodeCall(IOwnable.transferOwnership, (newOwner))});
    }
}
