// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignedDispatch} from "../contracts/SignedDispatch.sol";
import {DispatchLeaves} from "@crossecute/protocol/messaging/signed/DispatchLeaves.sol";
import {MerkleFixtures} from "./MerkleFixtures.sol";

/// @dev Writes vectors/merkle.json, which ts/test/merkle.test.ts replays. `guard3` uses the leaves and
///      the cast-computed hashes and root of the protocol guard's `test_publish_matchesOffchainVector`.
contract MerklePackageTest is Test, MerkleFixtures {
    function guardLeaves(uint256 count) internal pure returns (bytes[] memory) {
        return encoded(guardExecutionLeaves(count));
    }

    function multiLeaves() internal pure returns (bytes[] memory) {
        return encoded(multiExecutionLeaves());
    }

    function describe(string memory name, bytes[] memory leaves) internal returns (string memory) {
        bytes32[] memory hashes = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            hashes[i] = keccak256(abi.encode(keccak256(leaves[i])));
        }
        vm.serializeBytes(name, "leaves", leaves);
        vm.serializeBytes32(name, "root", SignedDispatch.root(leaves));
        for (uint256 i; i < leaves.length; ++i) {
            vm.serializeBytes32(name, string.concat("proof", vm.toString(i)), SignedDispatch.proof(leaves, i));
        }
        return vm.serializeBytes32(name, "hashes", hashes);
    }

    function test_writeMerkleVectors() public {
        uint8[6] memory sizes = [1, 2, 3, 5, 8, 9];
        string memory key = "merkle";
        for (uint256 i; i < sizes.length; ++i) {
            string memory name = string.concat("guard", vm.toString(sizes[i]));
            vm.serializeString(key, name, describe(name, guardLeaves(sizes[i])));
        }
        string memory json = vm.serializeString(key, "multi", describe("multi", multiLeaves()));
        vm.writeFile("vectors/merkle.json", json);
    }

    function test_guardVectorMatches() public pure {
        bytes[] memory leaves = guardLeaves(3);
        assertEq(SignedDispatch.root(leaves), 0xaa82123f67075907e439bf4fe2b85cf4d0ab12f4d94de47506e1f6f835034819);
        assertEq(
            keccak256(abi.encode(keccak256(leaves[0]))),
            0xbb78bf94c5e1c6f91b744da93971ac6777fc646ca26ab0005ef1e624277d7070
        );
        assertEq(
            keccak256(abi.encode(keccak256(leaves[1]))),
            0x19cc3775f22e8e5247aee60d5789fc9dc2011767e187f9c8872263cb6a7edca3
        );
        assertEq(
            keccak256(abi.encode(keccak256(leaves[2]))),
            0xf0bba0d846d5b46c2343ec2bf330ed19c35e1c41a202ad1c991c01b7a2f840b9
        );
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_proofsVerify(uint8 count) public pure {
        bytes[] memory leaves = guardLeaves(bound(count, 1, 33));
        bytes32 treeRoot = SignedDispatch.root(leaves);
        for (uint256 i; i < leaves.length; ++i) {
            DispatchLeaves.requireProof(
                SignedDispatch.proof(leaves, i), treeRoot, keccak256(abi.encode(keccak256(leaves[i])))
            );
        }
    }

    function test_proofIndexOutOfRangeReverts() public {
        vm.expectRevert(SignedDispatch.IndexOutOfRange.selector);
        this.outOfRange();
    }

    function outOfRange() external pure {
        SignedDispatch.proof(guardLeaves(2), 2);
    }
}
