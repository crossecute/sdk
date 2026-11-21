// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthorityRelayScript} from "../contracts/AuthorityRelayScript.sol";
import {PlanJson} from "../contracts/PlanJson.sol";
import {SafeTx} from "../contracts/Types.sol";
import {SafeTxHash} from "../contracts/SafeTxHash.sol";
import {ISignedTransmitter} from "../contracts/vendor/protocol135/ISignedTransmitter.sol";

contract AuthorityRelayScriptTest is Test, AuthorityRelayScript {
    function testWritesAttestableSafeRelay() public {
        Relay memory relay;
        relay.sourceChainId = 10;
        relay.safe = address(0x1234);
        relay.transmitter = address(0x5678);
        relay.nonce = 12;
        relay.recipient = hex"0102";
        relay.submission = hex"aabb";
        relay.attributes = new bytes[](1);
        relay.attributes[0] = hex"1234";
        vm.mockCall(
            relay.transmitter,
            abi.encodeCall(ISignedTransmitter.quoteAuthority, (relay.recipient, relay.submission, relay.attributes)),
            abi.encode(uint256(17))
        );
        SafeTx memory proposal = _authorityRelayTx(relay, relay.safe);

        assertEq(proposal.to, relay.transmitter);
        assertEq(proposal.nonce, relay.nonce);
        assertEq(proposal.operation, 0);
        assertEq(proposal.value, 17);
        assertEq(
            proposal.data,
            abi.encodeCall(ISignedTransmitter.relayAuthority, (relay.recipient, relay.submission, relay.attributes))
        );
        vm.writeFile(
            "out/test-authority-relay-safe-tx.json", PlanJson.safeTxTypedData(relay.sourceChainId, relay.safe, proposal)
        );
        vm.writeFile(
            "out/test-authority-relay-safe-tx-hash.txt",
            vm.toString(SafeTxHash.hash(relay.sourceChainId, relay.safe, proposal))
        );
    }
}
