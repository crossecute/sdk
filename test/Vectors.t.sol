// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {Harness} from "./CrossecuteScript.t.sol";

/// @notice Writes vectors/encoding.json from the protocol's own encoders, which the TypeScript
///         tests check their encoders against.
contract VectorsTest is Test {
    address constant ACCOUNT = 0x00000000000000000000000000000000DeaDBeef;

    function test_writeEncodingVectors() public {
        uint256[5] memory chainIds = [uint256(1), 10, 255, 8453, 1_000_000_000_000];
        string memory chains = "[";
        for (uint256 i; i < chainIds.length; ++i) {
            chains = string.concat(
                chains,
                i == 0 ? "" : ",",
                '{"chainId":"',
                vm.toString(chainIds[i]),
                '","chainIdentifier":"',
                vm.toString(Erc7930.encodeEvmChain(chainIds[i])),
                '","chainKey":"',
                vm.toString(ChainKey.forEvm(chainIds[i])),
                '","account":"',
                vm.toString(Erc7930.encodeEvm(chainIds[i], ACCOUNT)),
                '"}'
            );
        }
        chains = string.concat(chains, "]");

        Call[] memory calls = new Call[](2);
        calls[0] = Call(ACCOUNT, 0, hex"d09de08a");
        calls[1] = Call(address(0x1234), 1 ether, "");
        bytes memory body = Payload.encodeCalls(calls);

        string memory json = string.concat(
            '{"account":"',
            vm.toString(ACCOUNT),
            '","chains":',
            chains,
            ',"calls":[{"target":"',
            vm.toString(calls[0].target),
            '","value":"0","data":"0xd09de08a"},{"target":"',
            vm.toString(calls[1].target),
            '","value":"1000000000000000000","data":"0x"}],"callsPayload":"',
            vm.toString(body),
            '","bootstrapPayload":"',
            vm.toString(Payload.encodeBootstrap(Erc7930.encodeEvmChain(10), body)),
            '"}'
        );
        vm.writeFile("vectors/encoding.json", json);
    }

    /// @notice Writes vectors/multisend.json, the MultiSendCallOnly table `ts/src/safeTx.ts`
    ///         must repeat.
    function test_writeMultiSendVectors() public {
        Harness h = new Harness(address(0));
        string[3] memory versions = ["1.3.0", "1.4.1", "1.5.0"];
        string memory json = "{";
        for (uint256 i; i < versions.length; ++i) {
            (address[] memory addresses, bytes32 codeHash) = h.knownMultiSendCallOnly(versions[i]);
            json = string.concat(json, i == 0 ? '"' : ',"', versions[i], '":{"addresses":[');
            for (uint256 j; j < addresses.length; ++j) {
                json = string.concat(json, j == 0 ? '"' : ',"', vm.toString(addresses[j]), '"');
            }
            json = string.concat(json, '],"codeHash":"', vm.toString(codeHash), '"}');
        }
        vm.writeFile("vectors/multisend.json", string.concat(json, "}"));
    }
}
