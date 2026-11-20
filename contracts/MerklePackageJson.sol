// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {MerklePackage, MerkleEntry, ReceiverNonce, MerklePackages} from "./MerklePackage.sol";

/// @title MerklePackageJson
/// @notice Writes a `MerklePackage` as the file `parseMerklePackage` reads in the TypeScript SDK and
///         signers review: decimal-string integers, lowercase hex, and the field order of
///         `merklePackageToJSON`.
library MerklePackageJson {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function toJson(MerklePackage memory pkg) internal pure returns (string memory json) {
        json = string.concat(
            '{"version":',
            vm.toString(MerklePackages.VERSION),
            ',"root":"',
            vm.toString(pkg.root),
            '","receiverNonces":['
        );
        for (uint256 i; i < pkg.receiverNonces.length; ++i) {
            json = string.concat(json, i == 0 ? "" : ",", _receiverNonce(pkg.receiverNonces[i]));
        }
        json = string.concat(json, '],"leaves":[');
        for (uint256 i; i < pkg.leaves.length; ++i) {
            json = string.concat(json, i == 0 ? "" : ",", _entry(pkg.leaves[i]));
        }
        json = string.concat(json, "]}");
    }

    function _receiverNonce(ReceiverNonce memory r) private pure returns (string memory) {
        return string.concat(
            '{"destination":"', vm.toString(r.destination), '","nextNonce":"', vm.toString(r.nextNonce), '"}'
        );
    }

    function _entry(MerkleEntry memory e) private pure returns (string memory json) {
        json = string.concat(
            '{"destination":"',
            vm.toString(e.leaf.destination),
            '","nonce":"',
            vm.toString(e.leaf.nonce),
            '","validAfter":"',
            vm.toString(e.leaf.validAfter),
            '","deadline":"',
            vm.toString(e.leaf.deadline)
        );
        json = string.concat(
            json,
            '","calls":"',
            vm.toString(e.leaf.calls),
            '","attributes":',
            _bytesArray(e.leaf.attributes),
            ',"hash":"',
            vm.toString(e.hash),
            '","proof":',
            _wordArray(e.proof),
            "}"
        );
    }

    function _bytesArray(bytes[] memory items) private pure returns (string memory json) {
        json = "[";
        for (uint256 i; i < items.length; ++i) {
            json = string.concat(json, i == 0 ? '"' : ',"', vm.toString(items[i]), '"');
        }
        json = string.concat(json, "]");
    }

    function _wordArray(bytes32[] memory items) private pure returns (string memory json) {
        json = "[";
        for (uint256 i; i < items.length; ++i) {
            json = string.concat(json, i == 0 ? '"' : ',"', vm.toString(items[i]), '"');
        }
        json = string.concat(json, "]");
    }
}
