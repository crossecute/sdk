// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Call} from "@crossecute/protocol/messaging/Call.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";
import {SignedDispatch} from "../contracts/SignedDispatch.sol";
import {PlanJson} from "../contracts/PlanJson.sol";
import {SafeTx} from "../contracts/Types.sol";
import {MerklePackage, MerkleEntry, ReceiverNonce, MerklePackages} from "../contracts/MerklePackage.sol";
import {MerklePackageJson} from "../contracts/MerklePackageJson.sol";
import {MerklePackageScript} from "../contracts/MerklePackageScript.sol";
import {DispatchLeaves} from "../contracts/vendor/protocol135/DispatchLeaves.sol";
import {ExecutionLeaf} from "../contracts/vendor/protocol135/SignedDispatchTypes.sol";
import {MerkleFixtures} from "./MerkleFixtures.sol";

contract PackageScript is MerklePackageScript {
    function addLeaf(ExecutionLeaf memory leaf) external {
        _addLeaf(leaf);
    }

    function addBatch(
        uint256 chainId,
        address receiver,
        uint256 nonce,
        uint256 validAfter,
        uint256 deadline,
        Call[] memory calls,
        bytes[] memory attributes
    ) external {
        _addLeaf(chainId, receiver, nonce, validAfter, deadline, calls, attributes);
    }

    function addReceiverNonce(bytes memory destination, uint256 nextNonce) external {
        _addReceiverNonce(destination, nextNonce);
    }

    function addReceiverNonce(uint256 chainId, address receiver, uint256 nextNonce) external {
        _addReceiverNonce(chainId, receiver, nextNonce);
    }

    function build() external view returns (MerklePackage memory) {
        return _merklePackage();
    }

    function write(string memory path) external {
        _writeMerklePackage(_merklePackage(), path);
    }
}

/// @dev Writes vectors/merkle-package-*.json, which ts/test/merkle.test.ts parses, verifies and re-serializes to
///      the same bytes, so the Solidity writer and the TypeScript reader cannot drift.
contract MerklePackageJsonTest is Test, MerkleFixtures {
    function build(ExecutionLeaf[] memory leaves, ReceiverNonce[] memory receiverNonces)
        external
        pure
        returns (MerklePackage memory)
    {
        return MerklePackages.build(leaves, receiverNonces);
    }

    function expectBuildRevert(bytes memory err, ExecutionLeaf[] memory leaves, ReceiverNonce[] memory nonces)
        internal
    {
        vm.expectRevert(err);
        this.build(leaves, nonces);
    }

    function _attributes(bytes memory a) internal pure returns (bytes[] memory attributes) {
        attributes = new bytes[](1);
        attributes[0] = a;
    }

    function test_treeMatchesSignedDispatch() public pure {
        uint8[6] memory sizes = [1, 2, 3, 5, 8, 9];
        for (uint256 s; s <= sizes.length; ++s) {
            bool multi = s == sizes.length;
            ExecutionLeaf[] memory leaves = multi ? multiExecutionLeaves() : guardExecutionLeaves(sizes[s]);
            MerklePackage memory pkg =
                MerklePackages.build(leaves, multi ? multiReceiverNonces() : guardReceiverNonces());
            bytes[] memory fields = encoded(leaves);

            assertEq(pkg.root, SignedDispatch.root(fields));
            assertEq(pkg.leaves.length, leaves.length);
            for (uint256 i; i < leaves.length; ++i) {
                assertEq(pkg.leaves[i].hash, keccak256(abi.encode(keccak256(fields[i]))));
                assertEq(pkg.leaves[i].proof, SignedDispatch.proof(fields, i));
                DispatchLeaves.requireProof(pkg.leaves[i].proof, pkg.root, pkg.leaves[i].hash);
            }
        }
    }

    function test_publishAndRegisterData() public pure {
        ExecutionLeaf[] memory leaves = guardExecutionLeaves(3);
        MerklePackage memory pkg = MerklePackages.build(leaves, guardReceiverNonces());
        assertEq(MerklePackages.publishData(pkg), SignedDispatch.publishData(encoded(leaves)));
        assertEq(MerklePackages.registerData(pkg), SignedDispatch.registerData(pkg.root));
    }

    function test_registerRootComposesIntoSafeTypedData() public view {
        MerklePackage memory pkg = MerklePackages.build(guardExecutionLeaves(3), guardReceiverNonces());
        address transmitter = address(0xa11ce);
        SafeTx memory t = SignedDispatch.transaction(transmitter, 5, MerklePackages.registerData(pkg), 0);
        string memory typedData = PlanJson.safeTxTypedData(1, address(0x5afe), t);
        assertEq(t.operation, 0);
        assertTrue(vm.contains(typedData, vm.toString(MerklePackages.registerData(pkg))));
        assertTrue(vm.contains(typedData, vm.toString(transmitter)));
    }

    function test_jsonLayout() public pure {
        MerklePackage memory pkg = MerklePackages.build(guardExecutionLeaves(1), guardReceiverNonces());
        assertEq(
            MerklePackageJson.toJson(pkg),
            string.concat(
                '{"version":1,"root":"0xbb78bf94c5e1c6f91b744da93971ac6777fc646ca26ab0005ef1e624277d7070",',
                '"receiverNonces":[{"destination":"0x000100000114","nextNonce":"0"}],',
                '"leaves":[{"destination":"0x000100000114","nonce":"0","validAfter":"0","deadline":"1000",',
                '"calls":"0xc0de","attributes":["0xaa"],',
                '"hash":"0xbb78bf94c5e1c6f91b744da93971ac6777fc646ca26ab0005ef1e624277d7070","proof":[]}]}'
            )
        );
    }

    function test_writeJsonVectors() public {
        vm.writeFile(
            "vectors/merkle-package-guard5.json",
            MerklePackageJson.toJson(MerklePackages.build(guardExecutionLeaves(5), guardReceiverNonces()))
        );
        vm.writeFile(
            "vectors/merkle-package-multi.json",
            MerklePackageJson.toJson(MerklePackages.build(multiExecutionLeaves(), multiReceiverNonces()))
        );
    }

    /* ============================== plan rules ============================== */

    function test_noLeavesReverts() public {
        expectBuildRevert(
            abi.encodeWithSelector(SignedDispatch.NoLeaves.selector), new ExecutionLeaf[](0), guardReceiverNonces()
        );
    }

    function test_duplicateLeafReverts() public {
        ExecutionLeaf[] memory leaves = guardExecutionLeaves(2);
        leaves[1] = leaves[0];
        expectBuildRevert(
            abi.encodeWithSelector(MerklePackages.DuplicateLeaf.selector, 1), leaves, guardReceiverNonces()
        );
    }

    function test_duplicateReceiverNonceReverts() public {
        ReceiverNonce[] memory nonces = new ReceiverNonce[](2);
        nonces[0] = ReceiverNonce(GUARD_DESTINATION, 0);
        nonces[1] = ReceiverNonce(GUARD_DESTINATION, 5);
        expectBuildRevert(
            abi.encodeWithSelector(MerklePackages.DuplicateReceiverNonce.selector, 1), guardExecutionLeaves(1), nonces
        );
    }

    function test_missingReceiverNonceReverts() public {
        ReceiverNonce[] memory nonces = new ReceiverNonce[](1);
        nonces[0] = ReceiverNonce(hex"0001000001aa", 0);
        expectBuildRevert(
            abi.encodeWithSelector(MerklePackages.MissingReceiverNonce.selector, 0), guardExecutionLeaves(1), nonces
        );
    }

    function test_staleNonceReverts() public {
        ReceiverNonce[] memory nonces = new ReceiverNonce[](1);
        nonces[0] = ReceiverNonce(GUARD_DESTINATION, 1);
        expectBuildRevert(
            abi.encodeWithSelector(MerklePackages.StaleNonce.selector, 0, 0, 1), guardExecutionLeaves(1), nonces
        );
    }

    function test_conflictingNonceReverts() public {
        ExecutionLeaf[] memory leaves = guardExecutionLeaves(2);
        leaves[1].nonce = 0;
        leaves[1].calls = hex"c0df";
        expectBuildRevert(
            abi.encodeWithSelector(MerklePackages.ConflictingNonce.selector, 1, 0), leaves, guardReceiverNonces()
        );
    }

    function test_unusedReceiverNonceReverts() public {
        ReceiverNonce[] memory nonces = new ReceiverNonce[](2);
        nonces[0] = ReceiverNonce(GUARD_DESTINATION, 0);
        nonces[1] = ReceiverNonce(hex"0001000001aa", 0);
        expectBuildRevert(
            abi.encodeWithSelector(MerklePackages.UnusedReceiverNonce.selector, 1), guardExecutionLeaves(1), nonces
        );
    }

    function test_sameBatchWithDifferentAttributesIsAllowed() public pure {
        ExecutionLeaf[] memory leaves = guardExecutionLeaves(2);
        leaves[1].nonce = 0;
        leaves[1].attributes = _attributes(hex"bb");
        MerklePackage memory pkg = MerklePackages.build(leaves, guardReceiverNonces());
        assertEq(pkg.leaves.length, 2);
        assertTrue(pkg.leaves[0].hash != pkg.leaves[1].hash);
    }

    /* =============================== script base ============================== */

    function test_scriptQueuesAndWrites() public {
        PackageScript script = new PackageScript();
        address receiver = address(0xaa);
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(0xbb), value: 1, data: hex"c0de"});

        script.addReceiverNonce(1, receiver, 7);
        script.addBatch(1, receiver, 7, 0, 1000, calls, _attributes(hex"aa"));
        ExecutionLeaf[] memory expected = new ExecutionLeaf[](2);
        expected[0] = ExecutionLeaf(Erc7930.encodeEvm(1, receiver), 7, 0, 1000, abi.encode(calls), _attributes(hex"aa"));
        expected[1] = ExecutionLeaf(Erc7930.encodeEvm(1, receiver), 8, 0, 1000, abi.encode(calls), new bytes[](0));
        script.addLeaf(expected[1]);

        ReceiverNonce[] memory nonces = new ReceiverNonce[](1);
        nonces[0] = ReceiverNonce(Erc7930.encodeEvm(1, receiver), 7);
        string memory json = MerklePackageJson.toJson(MerklePackages.build(expected, nonces));

        assertEq(MerklePackageJson.toJson(script.build()), json);
        script.write("out/merkle-package-script.json");
        assertEq(vm.readFile("out/merkle-package-script.json"), json);
    }

    function test_scriptRawReceiverNonceMatchesTypedOverload() public {
        PackageScript typed = new PackageScript();
        PackageScript raw = new PackageScript();
        ExecutionLeaf memory leaf =
            ExecutionLeaf(Erc7930.encodeEvm(10, address(0xcc)), 0, 0, 1, hex"01", new bytes[](0));
        typed.addLeaf(leaf);
        raw.addLeaf(leaf);
        typed.addReceiverNonce(10, address(0xcc), 0);
        raw.addReceiverNonce(Erc7930.encodeEvm(10, address(0xcc)), 0);
        assertEq(MerklePackageJson.toJson(typed.build()), MerklePackageJson.toJson(raw.build()));
    }

    function test_scriptBuildRevertsOnBadPlan() public {
        PackageScript script = new PackageScript();
        vm.expectRevert(abi.encodeWithSelector(SignedDispatch.NoLeaves.selector));
        script.build();
    }
}
