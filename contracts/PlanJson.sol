// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {HomeCall, Batch, Plan, SafeTx} from "./Types.sol";

/// @title PlanJson
/// @notice The two files a plan is written as. Integers are decimal strings so no reader
///         rounds a wei amount through a float.
library PlanJson {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant PLAN_VERSION = "crossecute-plan/1";

    /// @notice The Safe Transaction Builder format, bound to the owner Safe by
    ///         `meta.createdFromSafeAddress`.
    function safeBatch(Plan memory plan) internal pure returns (string memory json) {
        json = string.concat(
            '{"version":"1.0","chainId":"',
            vm.toString(plan.homeChainId),
            '","createdAt":0,"meta":{"name":"crossecute","description":"","createdFromSafeAddress":"',
            vm.toString(plan.owner),
            '"},"transactions":',
            _homeCalls(plan.calls, true),
            "}"
        );
    }

    function planFile(Plan memory p) internal pure returns (string memory json) {
        json = string.concat(
            '{"version":"',
            PLAN_VERSION,
            '","homeChainId":"',
            vm.toString(p.homeChainId),
            '","owner":"',
            vm.toString(p.owner),
            '","transmitter":"',
            vm.toString(p.transmitter),
            '","fee":"',
            vm.toString(p.fee),
            '","calls":',
            _homeCalls(p.calls, false),
            ',"batches":['
        );
        for (uint256 i; i < p.batches.length; ++i) {
            json = string.concat(json, i == 0 ? "" : ",", _batch(p.batches[i]));
        }
        json = string.concat(json, "]}");
    }

    /// @notice Safe EIP-712 typed data in the field order Forge Attest's `safe-eip712` reader
    ///         requires for its default profile.
    function safeTxTypedData(uint256 chainId, address safe, SafeTx memory t) internal pure returns (string memory) {
        return string.concat(
            '{"types":{"EIP712Domain":[{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"SafeTx":[{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"},',
            '{"name":"operation","type":"uint8"},{"name":"safeTxGas","type":"uint256"},{"name":"baseGas","type":"uint256"},',
            '{"name":"gasPrice","type":"uint256"},{"name":"gasToken","type":"address"},{"name":"refundReceiver","type":"address"},',
            '{"name":"nonce","type":"uint256"}]},"primaryType":"SafeTx","domain":{"chainId":"',
            vm.toString(chainId),
            '","verifyingContract":"',
            vm.toString(safe),
            '"},"message":',
            _safeTxMessage(t),
            "}"
        );
    }

    function _safeTxMessage(SafeTx memory t) private pure returns (string memory) {
        return string.concat(
            string.concat(
                '{"to":"',
                vm.toString(t.to),
                '","value":"',
                vm.toString(t.value),
                '","data":"',
                vm.toString(t.data),
                '","operation":"',
                vm.toString(t.operation),
                '","safeTxGas":"',
                vm.toString(t.safeTxGas)
            ),
            string.concat(
                '","baseGas":"',
                vm.toString(t.baseGas),
                '","gasPrice":"',
                vm.toString(t.gasPrice),
                '","gasToken":"',
                vm.toString(t.gasToken),
                '","refundReceiver":"',
                vm.toString(t.refundReceiver),
                '","nonce":"',
                vm.toString(t.nonce),
                '"}'
            )
        );
    }

    /// @param builder Adds the Transaction Builder's `operation` field.
    function _homeCalls(HomeCall[] memory calls, bool builder) private pure returns (string memory json) {
        json = "[";
        for (uint256 i; i < calls.length; ++i) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"to":"',
                vm.toString(calls[i].to),
                '","value":"',
                vm.toString(calls[i].value),
                '","data":"',
                vm.toString(calls[i].data),
                builder ? '","operation":"0"}' : '"}'
            );
        }
        json = string.concat(json, "]");
    }

    function _batch(Batch memory b) private pure returns (string memory json) {
        json = string.concat(
            '{"chainId":"',
            vm.toString(b.chainId),
            '","receiver":"',
            vm.toString(b.receiver),
            '","bootstrap":',
            b.bootstrap ? "true" : "false",
            ',"gasUsed":"',
            vm.toString(b.gasUsed),
            '","attributes":['
        );
        for (uint256 i; i < b.attributes.length; ++i) {
            json = string.concat(json, i == 0 ? '"' : ',"', vm.toString(b.attributes[i]), '"');
        }
        json = string.concat(json, '],"calls":', _calls(b.calls), "}");
    }

    function _calls(Call[] memory calls) private pure returns (string memory json) {
        json = "[";
        for (uint256 i; i < calls.length; ++i) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"target":"',
                vm.toString(calls[i].target),
                '","value":"',
                vm.toString(calls[i].value),
                '","data":"',
                vm.toString(calls[i].data),
                '"}'
            );
        }
        json = string.concat(json, "]");
    }
}
