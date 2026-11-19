"""Check vectors/lzoft.json and vectors/lzoft-protocol.json against protocol's own LayerZero OFT code.

Usage: check-lzoft-vectors.py /path/to/protocol

Writes a Forge script into the checkout's contracts/evm/script, runs it, and removes it, so use a checkout
that can be touched (CI's, or a copy). The script rebuilds each destination leaf hash, the roots, the options
attribute selector, the factory's conduitSalt and predictConduit, the Proxy initcode hash and the
createTransmitter calldata with protocol's LzOftMessage, LzMessage and LzOftConduitFactory, and reverts on
any difference from the SDK's vectors. protocol has no literal OFT vectors of its own to copy.
"""
import json, pathlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parents[1]
NAME = 'SdkOftVectors'


def source(v, pins):
    home = v['home']
    body = []
    for i, d in enumerate(v['destinations']):
        body += [
            f"        leaves[{i}] = LzOftConduitFactory.Leaf({d['chainKey']}, {d['eid']}, {d['oft']});",
            f"        hashes[{i}] = LzOftMessage.leaf(leaves[{i}].chainKey, leaves[{i}].eid, leaves[{i}].oft);",
            f"        require(hashes[{i}] == {d['leafHash']}, 'leaf {i}');",
        ]
    for count, expected in v['roots'].items():
        body.append(f"        require(LzOftMessage.root(_prefix(hashes, {count})) == {expected}, 'root {count}');")
    three = ', '.join(f'leaves[{i}]' for i in range(3))
    return f'''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {{Script}} from "forge-std/Script.sol";
import {{LzOftConduitFactory}} from "src/protocols/layerzero/LzOftConduitFactory.sol";
import {{LzOftMessage}} from "src/protocols/layerzero/LzOftMessage.sol";
import {{LzMessage}} from "src/protocols/layerzero/LzMessage.sol";

contract Impl {{
    function x() external {{}}
}}

contract {NAME} is Script {{
    function _prefix(bytes32[] memory all, uint256 n) internal pure returns (bytes32[] memory out) {{
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) out[i] = all[i];
    }}

    function run() external {{
        LzOftConduitFactory.Leaf[] memory leaves = new LzOftConduitFactory.Leaf[]({len(v['destinations'])});
        bytes32[] memory hashes = new bytes32[]({len(v['destinations'])});
{chr(10).join(body)}
        require(bytes4(LzMessage.OPTIONS_ATTRIBUTE) == bytes4({pins['optionsAttribute']['selector']}), 'options attribute');
        address f = {v['factory']};
        vm.etch(f, address(new LzOftConduitFactory(address(new Impl()), address(new Impl()))).code);
        LzOftConduitFactory factory = LzOftConduitFactory(f);
        require(factory.PROXY_INIT_CODE_HASH() == {pins['proxyInitCodeHash']['hash']}, 'proxy initcode hash');
        bytes32 destRoot = LzOftMessage.root(_prefix(hashes, 3));
        require(factory.conduitSalt({home['owner']}, {home['salt']}, {home['chainKey']}, {home['eid']}, {home['oft']}, destRoot) == {v['conduitSalt']}, 'conduitSalt');
        require(factory.predictConduit({home['owner']}, {home['salt']}, {home['chainKey']}, {home['eid']}, {home['oft']}, destRoot) == {v['conduit']}, 'predictConduit');
        LzOftConduitFactory.Leaf[] memory three = new LzOftConduitFactory.Leaf[](3);
        (three[0], three[1], three[2]) = ({three});
        require(keccak256(abi.encodeCall(LzOftConduitFactory.createTransmitter, ({home['salt']}, {home['oft']}, three))) == keccak256(hex"{v['createData'][2:]}"), 'createTransmitter');
    }}
}}
'''


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    evm = pathlib.Path(sys.argv[1]).resolve() / 'contracts/evm'
    v = json.loads((root / 'vectors/lzoft.json').read_text())
    pins = json.loads((root / 'vectors/lzoft-protocol.json').read_text())
    path = evm / f'script/{NAME}.s.sol'
    path.write_text(source(v, pins))
    try:
        subprocess.run(['forge', 'script', str(path.relative_to(evm)), '--tc', NAME], cwd=evm, check=True)
    finally:
        path.unlink()
    print('vectors/lzoft.json matches protocol ' + pins['revision'])
