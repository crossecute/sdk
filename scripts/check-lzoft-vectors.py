"""Check vectors/lzoft.json and vectors/lzoft-protocol.json against protocol's own LayerZero OFT code.

Usage: check-lzoft-vectors.py /path/to/protocol

Writes a Forge script into the checkout's contracts/evm/script, runs it, and removes it, so use a checkout
that can be touched (CI's, or a copy). The script rebuilds each destination leaf hash, the root of every listed
prefix of the destinations, the options attribute selector, the factory's conduitSalt and predictConduit, the
fixture factory address, Proxy initcode hash and the createTransmitter calldata with protocol's LzOftConduitAddress, LzMessage and
LzOftConduitFactory and LzOftDeploy, and reverts on any difference from the SDK's vectors. protocol has no literal OFT vectors
of its own to copy. Every value is matched against a strict format before it is written into Solidity.
"""
import json, pathlib, re, subprocess, sys, tomllib

root = pathlib.Path(__file__).resolve().parents[1]
NAME = 'SdkOftVectors'
UINT32_MAX = 2**32 - 1


def fail(message):
    raise SystemExit('vectors: ' + message)


def hexstr(value, nbytes, where):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{%d}' % (2 * nbytes), value):
        fail(f'{where} is not {nbytes} bytes of hex: {value!r}')
    return value[2:]


def uint(value, low, high, where):
    if type(value) is not int or not low <= value <= high:
        fail(f'{where} is not an integer in [{low}, {high}]: {value!r}')
    return value


def b32(value, where):
    return f'bytes32(hex"{hexstr(value, 32, where)}")'


def addr(value, where):
    return f'address(bytes20(hex"{hexstr(value, 20, where)}"))'


def shape(v, pins):
    """The vector fields as Solidity expressions, or a SystemExit naming the first malformed field."""
    destinations = v.get('destinations')
    if not isinstance(destinations, list) or not destinations:
        fail('destinations is not a nonempty list')
    out = {'destinations': [], 'roots': {}}
    for i, d in enumerate(destinations):
        out['destinations'].append((
            b32(d.get('chainKey'), f'destinations[{i}].chainKey'),
            uint(d.get('eid'), 1, UINT32_MAX, f'destinations[{i}].eid'),
            addr(d.get('oft'), f'destinations[{i}].oft'),
            b32(d.get('leafHash'), f'destinations[{i}].leafHash'),
        ))
    roots = v.get('roots')
    if not isinstance(roots, dict) or not roots:
        fail('roots is not a nonempty object')
    for count, expected in roots.items():
        if not re.fullmatch(r'[1-9][0-9]*', count) or int(count) > len(destinations):
            fail(f'roots key {count!r} is not a destination count from 1 to {len(destinations)}')
        out['roots'][int(count)] = b32(expected, f'roots[{count}]')
    out['count'] = uint(v.get('conduitLeaves'), 1, len(destinations), 'conduitLeaves')
    home = v.get('home') or {}
    out['owner'] = addr(home.get('owner'), 'home.owner')
    out['salt'] = b32(home.get('salt'), 'home.salt')
    out['homeKey'] = b32(home.get('chainKey'), 'home.chainKey')
    out['homeEid'] = uint(home.get('eid'), 1, UINT32_MAX, 'home.eid')
    out['homeOft'] = addr(home.get('oft'), 'home.oft')
    out['factory'] = addr(v.get('factory'), 'factory')
    out['conduitSalt'] = b32(v.get('conduitSalt'), 'conduitSalt')
    out['conduit'] = addr(v.get('conduit'), 'conduit')
    out['proxyHash'] = b32(v.get('proxyInitCodeHash'), 'proxyInitCodeHash')
    data = v.get('createData')
    if not isinstance(data, str) or not re.fullmatch(r'0x([0-9a-fA-F]{2})+', data):
        fail('createData is not nonempty whole bytes of hex')
    out['createData'] = data[2:]
    out['selector'] = f'bytes4(hex"{hexstr(pins["optionsAttribute"]["selector"], 4, "pins selector")}")'
    if out['proxyHash'] != b32(pins['proxyInitCodeHash']['hash'], 'pins proxy hash'):
        fail('proxyInitCodeHash differs from vectors/lzoft-protocol.json')
    return out


def source(v, pins, deployment):
    f = shape(v, pins)
    guard = addr(deployment.get('address'), 'safe-guard.toml address')
    multi_send = addr(deployment.get('multi_send_call_only', {}).get('address'), 'safe-guard.toml MultiSendCallOnly')
    body = []
    for i, (key, eid, oft, leaf_hash) in enumerate(f['destinations']):
        body += [
            f"        destinations[{i}] = ILzOftConduitFactory.Destination({key}, {eid}, {oft});",
            f"        require(LzOftConduitAddress.leafHash(destinations[{i}]) == {leaf_hash}, 'leaf {i}');",
        ]
    for count, expected in f['roots'].items():
        body.append(
            f"        require(LzOftConduitAddress.destRoot(_prefix(destinations, {count}), "
            f"{f['homeKey']}, {f['homeEid']}) == {expected}, 'root {count}');"
        )
    n, total = f['count'], len(f['destinations'])
    fields = f"{f['owner']}, {f['salt']}, {f['homeKey']}, {f['homeEid']}, {f['homeOft']}"
    return f'''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {{Script}} from "forge-std/Script.sol";
import {{LzOftDeploy}} from "script/deploy/LzOftDeploy.sol";
import {{LzOftConduitFactory}} from "src/protocols/layerzero/LzOftConduitFactory.sol";
import {{ILzOftConduitFactory}} from "src/protocols/layerzero/ILzOftConduitFactory.sol";
import {{LzOftConduitAddress}} from "src/protocols/layerzero/LzOftConduitAddress.sol";
import {{LzMessage}} from "src/protocols/layerzero/LzMessage.sol";

contract Impl {{
    function x() external {{}}
}}

contract {NAME} is Script {{
    function _prefix(ILzOftConduitFactory.Destination[] memory all, uint256 n)
        internal
        pure
        returns (ILzOftConduitFactory.Destination[] memory out)
    {{
        out = new ILzOftConduitFactory.Destination[](n);
        for (uint256 i; i < n; ++i) out[i] = all[i];
    }}

    function run() external {{
        ILzOftConduitFactory.Destination[] memory destinations = new ILzOftConduitFactory.Destination[]({total});
{chr(10).join(body)}
        require(bytes4(LzMessage.OPTIONS_ATTRIBUTE) == {f['selector']}, 'options attribute');
        address f = {f['factory']};
        address fixtureTreasury = address(uint160(0x7ea5));
        require(LzOftDeploy.predictFactory(fixtureTreasury, {guard}, {multi_send}) == f, 'factory fixture');
        vm.etch(f, address(new LzOftConduitFactory(address(new Impl()), address(new Impl()), fixtureTreasury)).code);
        LzOftConduitFactory factory = LzOftConduitFactory(f);
        require(factory.PROXY_INIT_CODE_HASH() == {f['proxyHash']}, 'proxy initcode hash');
        ILzOftConduitFactory.Destination[] memory used = _prefix(destinations, {n});
        bytes32 destRoot = LzOftConduitAddress.destRoot(used, {f['homeKey']}, {f['homeEid']});
        require(factory.conduitSalt({fields}, destRoot) == {f['conduitSalt']}, 'conduitSalt');
        require(factory.predictConduit({fields}, destRoot) == {f['conduit']}, 'predictConduit');
        bytes memory data = abi.encodeCall(ILzOftConduitFactory.createTransmitter, ({f['salt']}, {f['homeOft']}, used));
        require(keccak256(data) == keccak256(hex"{f['createData']}"), 'createTransmitter');
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
    deployment = tomllib.loads((evm / 'deploy/safe-guard.toml').read_text())
    path.write_text(source(v, pins, deployment))
    try:
        subprocess.run(['forge', 'script', str(path.relative_to(evm)), '--tc', NAME], cwd=evm, check=True)
    finally:
        path.unlink()
    print('vectors/lzoft.json matches protocol ' + pins['revision'])
