// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {ILzOftConduitFactory, LzOft} from "../contracts/LzOft.sol";

/// @dev External wrappers so `vm.expectRevert` sees the library's reverts.
contract LzOftHarness {
    function root(ILzOftConduitFactory.Leaf[] memory leaves) external pure returns (bytes32) {
        return LzOft.root(leaves);
    }

    function rootFor(ILzOftConduitFactory.Leaf[] memory leaves, bytes32 homeChainKey, uint32 homeEid)
        external
        pure
        returns (bytes32)
    {
        return LzOft.root(leaves, homeChainKey, homeEid);
    }

    function optionsAttribute(bytes memory rawOptions) external pure returns (bytes memory) {
        return LzOft.optionsAttribute(rawOptions);
    }

    function createData(bytes32 salt, address homeOft, ILzOftConduitFactory.Leaf[] memory leaves)
        external
        pure
        returns (bytes memory)
    {
        return LzOft.createTransmitterData(salt, homeOft, leaves);
    }
}

/// @notice Writes vectors/lzoft.json, which the TypeScript builders must reproduce, and checks the library's
///         constants against vectors/lzoft-protocol.json, which scripts/sync-protocol135.py derives from protocol.
contract LzOftTest is Test {
    LzOftHarness h = new LzOftHarness();

    address constant OWNER = 0x00000000000000000000000000000000DeaDBeef;
    address constant FACTORY = 0x96ef3e86a1e5Ce9F8A0c30CD0411d7778480Dd32;
    address constant HOME_OFT = 0x00000000000000000000000000000000000F7001;
    bytes32 constant SALT = keccak256("oft-salt");
    uint256 constant HOME_CHAIN_ID = 252;
    uint32 constant HOME_EID = 30255;
    uint256 constant DESTINATIONS = 5;

    function _chainIds() internal pure returns (uint256[DESTINATIONS] memory) {
        return [uint256(10), 8453, 42_161, 137, 56];
    }

    function _eids() internal pure returns (uint32[DESTINATIONS] memory) {
        return [uint32(30111), 30184, 30110, 30109, 30102];
    }

    /// @dev The five destinations in ascending `chainKey` order, as the factory requires.
    function _sorted() internal pure returns (ILzOftConduitFactory.Leaf[] memory leaves, uint256[] memory chainIds) {
        leaves = new ILzOftConduitFactory.Leaf[](DESTINATIONS);
        chainIds = new uint256[](DESTINATIONS);
        for (uint256 i; i < DESTINATIONS; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast) a small index
            address oft = address(uint160(0xD0F7000 + i));
            leaves[i] = ILzOftConduitFactory.Leaf(ChainKey.forEvm(_chainIds()[i]), _eids()[i], oft);
            chainIds[i] = _chainIds()[i];
            for (uint256 j = i; j > 0 && leaves[j].chainKey < leaves[j - 1].chainKey; --j) {
                (leaves[j], leaves[j - 1]) = (leaves[j - 1], leaves[j]);
                (chainIds[j], chainIds[j - 1]) = (chainIds[j - 1], chainIds[j]);
            }
        }
    }

    function _prefix(ILzOftConduitFactory.Leaf[] memory leaves, uint256 count)
        internal
        pure
        returns (ILzOftConduitFactory.Leaf[] memory out)
    {
        out = new ILzOftConduitFactory.Leaf[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = leaves[i];
        }
    }

    function _options() internal pure returns (bytes memory) {
        // Type 3, one executor option: lzCompose for index 0 with 200,000 gas and no value.
        return abi.encodePacked(uint16(3), uint8(1), uint16(19), uint8(3), uint16(0), uint128(200_000));
    }

    function test_constantsMatchTheProtocolPins() public view {
        string memory pins = vm.readFile("vectors/lzoft-protocol.json");
        assertEq(abi.encodePacked(LzOft.OPTIONS_ATTRIBUTE), vm.parseJsonBytes(pins, ".optionsAttribute.selector"));
        assertEq(LzOft.PROXY_INIT_CODE_HASH, vm.parseJsonBytes32(pins, ".proxyInitCodeHash.hash"));
    }

    function test_theAttributeIsTheSelectorThenTheRawOptions() public pure {
        assertEq(LzOft.optionsAttribute(hex"0003aa"), abi.encodePacked(bytes4(0x98585a20), hex"0003aa"));
    }

    function test_emptyOptionsAreRefused() public {
        vm.expectRevert(LzOft.EmptyOptions.selector);
        h.optionsAttribute("");
    }

    function test_aSingleLeafIsItsOwnRoot() public pure {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        assertEq(LzOft.root(_prefix(leaves, 1)), LzOft.leafHash(leaves[0]));
    }

    function test_theRootPairsWithTheSortedHashAndCarriesAnOddLeafUp() public pure {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        bytes32 a = LzOft.leafHash(leaves[0]);
        bytes32 b = LzOft.leafHash(leaves[1]);
        bytes32 c = LzOft.leafHash(leaves[2]);
        bytes32 ab = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        assertEq(LzOft.root(_prefix(leaves, 2)), ab);
        bytes32 abc = ab < c ? keccak256(abi.encodePacked(ab, c)) : keccak256(abi.encodePacked(c, ab));
        assertEq(LzOft.root(_prefix(leaves, 3)), abc);
    }

    function test_theLeafIsHashedTwice() public pure {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        ILzOftConduitFactory.Leaf memory l = leaves[0];
        assertNotEq(LzOft.leafHash(l), keccak256(abi.encode(l.chainKey, l.eid, l.oft)));
    }

    function test_noLeavesAreRefused() public {
        vm.expectRevert(LzOft.NoDestinations.selector);
        h.root(new ILzOftConduitFactory.Leaf[](0));
    }

    function test_unsortedAndRepeatedLeavesAreRefused() public {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        ILzOftConduitFactory.Leaf[] memory two = _prefix(leaves, 2);
        (two[0], two[1]) = (two[1], two[0]);
        vm.expectRevert(abi.encodeWithSelector(LzOft.LeavesNotSorted.selector, 1));
        h.root(two);
        vm.expectRevert(abi.encodeWithSelector(LzOft.LeavesNotSorted.selector, 1));
        h.createData(SALT, HOME_OFT, two);

        two[1] = two[0];
        vm.expectRevert(abi.encodeWithSelector(LzOft.LeavesNotSorted.selector, 1));
        h.root(two);
    }

    function test_aZeroEidOrOftIsRefused() public {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        ILzOftConduitFactory.Leaf[] memory one = _prefix(leaves, 1);
        one[0].eid = 0;
        vm.expectRevert(abi.encodeWithSelector(LzOft.BadLeaf.selector, 0));
        h.root(one);
        one[0].eid = 1;
        one[0].oft = address(0);
        vm.expectRevert(abi.encodeWithSelector(LzOft.BadLeaf.selector, 0));
        h.root(one);
    }

    function test_aLeafForTheHomeChainOrEidIsRefused() public {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        ILzOftConduitFactory.Leaf[] memory two = _prefix(leaves, 2);
        h.rootFor(two, ChainKey.forEvm(HOME_CHAIN_ID), HOME_EID);
        vm.expectRevert(abi.encodeWithSelector(LzOft.BadLeaf.selector, 1));
        h.rootFor(two, two[1].chainKey, HOME_EID);
        vm.expectRevert(abi.encodeWithSelector(LzOft.BadLeaf.selector, 0));
        h.rootFor(two, ChainKey.forEvm(HOME_CHAIN_ID), two[0].eid);
    }

    function test_theCreationDataIsTheFactorysCall() public pure {
        (ILzOftConduitFactory.Leaf[] memory leaves,) = _sorted();
        bytes memory data = LzOft.createTransmitterData(SALT, HOME_OFT, _prefix(leaves, 3));
        assertEq(bytes4(data), bytes4(keccak256("createTransmitter(bytes32,address,(bytes32,uint32,address)[])")));
    }

    function test_theAddressIsTheCreate2OfTheSaltAndTheProxyInitcode() public pure {
        bytes32 destRoot = keccak256("root");
        bytes32 homeKey = ChainKey.forEvm(HOME_CHAIN_ID);
        bytes32 s = keccak256(abi.encode(OWNER, SALT, homeKey, HOME_EID, HOME_OFT, destRoot));
        assertEq(LzOft.conduitSalt(OWNER, SALT, homeKey, HOME_EID, HOME_OFT, destRoot), s);
        assertEq(
            LzOft.predictConduit(FACTORY, OWNER, SALT, homeKey, HOME_EID, HOME_OFT, destRoot),
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, s, LzOft.PROXY_INIT_CODE_HASH)))))
        );
    }

    function test_theAddressMovesWithEveryBoundField() public pure {
        bytes32 root = keccak256("root");
        bytes32 key = ChainKey.forEvm(HOME_CHAIN_ID);
        address base = LzOft.predictConduit(FACTORY, OWNER, SALT, key, HOME_EID, HOME_OFT, root);
        assertNotEq(base, LzOft.predictConduit(address(1), OWNER, SALT, key, HOME_EID, HOME_OFT, root));
        assertNotEq(base, LzOft.predictConduit(FACTORY, address(1), SALT, key, HOME_EID, HOME_OFT, root));
        assertNotEq(base, LzOft.predictConduit(FACTORY, OWNER, bytes32(0), key, HOME_EID, HOME_OFT, root));
        assertNotEq(base, LzOft.predictConduit(FACTORY, OWNER, SALT, bytes32(0), HOME_EID, HOME_OFT, root));
        assertNotEq(base, LzOft.predictConduit(FACTORY, OWNER, SALT, key, HOME_EID + 1, HOME_OFT, root));
        assertNotEq(base, LzOft.predictConduit(FACTORY, OWNER, SALT, key, HOME_EID, address(1), root));
        assertNotEq(base, LzOft.predictConduit(FACTORY, OWNER, SALT, key, HOME_EID, HOME_OFT, bytes32(0)));
    }

    function _destinationsJson(ILzOftConduitFactory.Leaf[] memory leaves, uint256[] memory chainIds)
        internal
        pure
        returns (string memory out)
    {
        out = "[";
        for (uint256 i; i < leaves.length; ++i) {
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                '{"chainId":"',
                vm.toString(chainIds[i]),
                '","chainKey":"',
                vm.toString(leaves[i].chainKey),
                '","eid":',
                vm.toString(leaves[i].eid),
                ',"oft":"',
                vm.toString(leaves[i].oft),
                '","leafHash":"',
                vm.toString(LzOft.leafHash(leaves[i])),
                '"}'
            );
        }
        return string.concat(out, "]");
    }

    function _rootsJson(ILzOftConduitFactory.Leaf[] memory leaves) internal pure returns (string memory out) {
        uint256[4] memory counts = [uint256(1), 2, 3, 5];
        out = "{";
        for (uint256 i; i < counts.length; ++i) {
            out = string.concat(
                out,
                i == 0 ? '"' : ',"',
                vm.toString(counts[i]),
                '":"',
                vm.toString(LzOft.root(_prefix(leaves, counts[i]))),
                '"'
            );
        }
        return string.concat(out, "}");
    }

    function _homeJson(bytes32 homeKey) internal pure returns (string memory) {
        return string.concat(
            '{"owner":"',
            vm.toString(OWNER),
            '","salt":"',
            vm.toString(SALT),
            '","chainId":"',
            vm.toString(HOME_CHAIN_ID),
            '","chainKey":"',
            vm.toString(homeKey),
            '","eid":',
            vm.toString(HOME_EID),
            ',"oft":"',
            vm.toString(HOME_OFT),
            '"}'
        );
    }

    /// @dev The conduit of the first three destinations, which `LzOft.root` checks against the home too.
    function _conduitJson(ILzOftConduitFactory.Leaf[] memory leaves, bytes32 homeKey)
        internal
        pure
        returns (string memory)
    {
        ILzOftConduitFactory.Leaf[] memory three = _prefix(leaves, 3);
        bytes32 destRoot = LzOft.root(three, homeKey, HOME_EID);
        return string.concat(
            '"createData":"',
            vm.toString(LzOft.createTransmitterData(SALT, HOME_OFT, three)),
            '","conduitSalt":"',
            vm.toString(LzOft.conduitSalt(OWNER, SALT, homeKey, HOME_EID, HOME_OFT, destRoot)),
            '","conduit":"',
            vm.toString(LzOft.predictConduit(FACTORY, OWNER, SALT, homeKey, HOME_EID, HOME_OFT, destRoot)),
            '"'
        );
    }

    function test_writeLzOftVectors() public {
        (ILzOftConduitFactory.Leaf[] memory leaves, uint256[] memory chainIds) = _sorted();
        bytes32 homeKey = ChainKey.forEvm(HOME_CHAIN_ID);
        string memory json = string.concat(
            '{"options":"',
            vm.toString(_options()),
            '","optionsAttribute":"',
            vm.toString(LzOft.optionsAttribute(_options())),
            '","destinations":',
            _destinationsJson(leaves, chainIds),
            ',"roots":',
            _rootsJson(leaves)
        );
        json = string.concat(
            json,
            ',"home":',
            _homeJson(homeKey),
            ',"factory":"',
            vm.toString(FACTORY),
            '",',
            _conduitJson(leaves, homeKey),
            "}"
        );
        vm.writeFile("vectors/lzoft.json", json);
    }
}
