"""Regenerate what the SDK derives from the pinned @crossecute/protocol release.

Usage: sync-protocol.py [--check] /path/to/protocol
       sync-protocol.py --revision

The checkout must be at REVISION with the npm package built (npm --prefix npm run build from contracts/evm). VERSION is the single source for the release: package.json's dependency, the
generated ABI header and `PROTOCOL_VERSION` repeat it, and ts/test/protocolRelease.test.ts compares them.
`--check` regenerates in memory and fails if any committed file differs; `--revision` prints REVISION for CI.
"""
import json, pathlib, re, shutil, subprocess, sys

VERSION = '0.4.0'
REVISION = '59b140c3e2133b4fca54dd4fdac77c99487d937b'  # the npm-v0.4.0 tag
root = pathlib.Path(__file__).resolve().parents[1]

# (exported name, Forge profile directory, artifact file, contract)
ABIS = [
    ('signedTransmitterAbi', 'evm', 'SignedTransmitter', 'SignedTransmitter'),
    ('signedReceiverAbi', 'evm', 'SignedReceiver', 'SignedReceiver'),
    ('transceiverExtensionAbi', 'evm', 'TransceiverExtension', 'TransceiverExtension'),
    ('transceiverBaseAbi', 'evm', 'TransceiverBase', 'TransceiverBase'),
    ('lzOftConduitFactoryAbi', 'evm', 'LzOftConduitFactory', 'LzOftConduitFactory'),
    ('lzOftTransmitterAbi', 'evm', 'LzOftTransmitter', 'LzOftTransmitter'),
    ('lzOftReceiverAbi', 'evm', 'LzOftReceiver', 'LzOftReceiver'),
]
# Functions and events each trimmed ABI keeps: what the builders and the README use, plus the signed-flow
# views. Inherited access-control, ownership and admin members are dropped. Every custom error is kept so
# viem can decode reverts. A name missing from the artifact fails the sync. The other ABIs are small and whole.
MEMBERS = {
    'signedTransmitterAbi': {
        'functions': ['sendMessage', 'quoteMessage', 'bootstrap', 'bootstrapPayload', 'payloadForCalls', 'quoteBootstrap',
                      'quoteMessageSigned', 'quoteLeaf', 'quoteAuthority', 'relayLeaf', 'relayAuthority', 'registerRoot',
                      'isRootRegistered', 'isLeafRelayed', 'isSigned', 'initializeSigned', 'isBootstrapped', 'isBootstrappedOn',
                      'destinationReceiverOn', 'recipientOn', 'owner', 'execute'],
        'events': ['MessageSent', 'LeafRelayed', 'AuthorityRelayed', 'RootRegistered', 'DestinationBootstrapped',
                   'Executed', 'SignedTransmitterInitialized'],
    },
    'signedReceiverAbi': {
        'functions': ['submitMessage', 'submitLeaf', 'submitAuthority', 'submitAuthorityBatch', 'selection', 'graph',
                      'record', 'authorityGraph', 'authorityRecords', 'nextNonce', 'executionAt', 'isMessageExecuted',
                      'isSourceTransmitter', 'sourceTransmitter', 'SOURCE_AUTHORITY_GUARD', 'initializeSigned'],
        'events': ['LeafExecuted', 'MessageExecuted', 'DuplicateMessage', 'AuthoritySelected', 'SignedReceiverInitialized',
                   'ReceiverInitialized', 'ReceiverExecuted', 'Delivered'],
    },
    'transceiverExtensionAbi': {
        'functions': ['predictConduit', 'predictTransmitter', 'conduitSalt', 'signedAuthority'],
        'events': ['ConduitCreated', 'BootstrapSent'],
    },
    # The OFT conduit's own members. Its signed entry points are signedTransmitterAbi's and signedReceiverAbi's.
    'lzOftConduitFactoryAbi': {
        'functions': ['createTransmitter', 'predictConduit', 'conduitSalt', 'predictReceiver', 'bootstrapRoute',
                      'destinationOf', 'isSigned', 'signedConduitBootstrap', 'PROXY_INIT_CODE_HASH', 'localChainKey',
                      'SIGNED_BOOTSTRAP', 'transmitterImplementation', 'receiverImplementation', 'treasury'],
        'events': ['TransmitterCreated', 'ReceiverCreated', 'SignedConduitCreated'],
    },
    'lzOftTransmitterAbi': {
        'functions': ['homeOft', 'destinationOf', 'supportsAttribute', 'LZ_OPTIONS_ATTRIBUTE'],
        'events': [],
    },
    'lzOftReceiverAbi': {
        'functions': ['homeOft', 'localOft'],
        'events': [],
    },
    'transceiverBaseAbi': {
        'functions': ['predictReceiver', 'createTransmitter', 'bootstrap', 'quoteBootstrap', 'bootstrapSigned',
                      'quoteBootstrapSigned'],
        'events': ['ConduitCreated', 'BootstrapSent'],
    },
}


# Package interfaces take precedence. Implementation artifacts supply provider-specific and inherited members.
# Library errors also decode reverts bubbled from other components such as the guard.
INTERFACES = {
    'signedTransmitterAbi': ['ISignedTransmitter', 'ISignedTransmitterInit'],
    'signedReceiverAbi': ['ISignedReceiver', 'ISignedReceiverInit', 'IReceiverAuthority'],
    'lzOftConduitFactoryAbi': ['ILzOftConduitFactory', 'ILzOftSignedConduitFactory'],
}
LIBRARY_ERRORS = {
    'signedTransmitterAbi': ['SignedDispatchCalls', 'DispatchLeaves', 'OrderedMerkle'],
    'signedReceiverAbi': ['SignedDispatchCalls', 'DispatchLeaves', 'OrderedMerkle'],
    'lzOftConduitFactoryAbi': ['OrderedMerkle'],
    'lzOftTransmitterAbi': ['SignedDispatchCalls', 'DispatchLeaves', 'OrderedMerkle'],
    'lzOftReceiverAbi': ['SignedDispatchCalls', 'DispatchLeaves', 'OrderedMerkle'],
}


def package_abi(protocol, name):
    return json.loads((protocol / f'contracts/evm/npm/abi/{name}.json').read_text())


def merge_abis(*abis):
    def parameter_type(param):
        if not param['type'].startswith('tuple'):
            return param['type']
        return '(' + ','.join(map(parameter_type, param['components'])) + ')' + param['type'][5:]

    entries = {}
    for abi in abis:
        for entry in abi:
            key = (entry['type'], entry.get('name'), tuple(map(parameter_type, entry.get('inputs', []))))
            entries.setdefault(key, entry)
    return list(entries.values())


def trim(export, abi):
    keep = MEMBERS.get(export)
    if keep is None:
        return abi
    for kind, key in (('function', 'functions'), ('event', 'events')):
        missing = set(keep[key]) - {e['name'] for e in abi if e['type'] == kind}
        if missing:
            raise SystemExit(f'{export}: protocol artifact has no {kind} {sorted(missing)}')
    return [e for e in abi if e['type'] == 'error'
            or e['type'] == 'function' and e['name'] in keep['functions']
            or e['type'] == 'event' and e['name'] in keep['events']]


# Vectors copied from docs/vectors/safe-authority-updates-109.json so the builders are checked against
# protocol's own encodings: (id in the protocol file, key in vectors/authority.json).
VECTORS = [('eoa-select', 'single'), ('multilevel-shared', 'shared')]
VECTOR_SOURCE = 'docs/vectors/safe-authority-updates-109.json'

# Values the OFT builders repeat, derived here from the pinned protocol so the Solidity and TypeScript
# constants are tested against protocol itself: the options attribute selector from the string literal in
# LzMessage.sol, and the initcode hash every conduit address is CREATE2'd from, from Proxy's artifact.
LZ_MESSAGE = 'contracts/evm/src/protocols/layerzero/LzMessage.sol'
PROXY_ARTIFACT = 'contracts/evm/out/Proxy.sol/Proxy.json'
OFT_PINS = 'vectors/lzoft-protocol.json'


def keccak256(data):
    """Keccak-256 through Foundry's `cast`, which hashlib has no digest for. CI installs Foundry; locally
    `cast` is on PATH or in ~/.foundry/bin."""
    cast = shutil.which('cast') or str(pathlib.Path.home() / '.foundry/bin/cast')
    return subprocess.check_output([cast, 'keccak', '0x' + data.hex()], text=True).strip().removeprefix('0x')


def vectors(protocol):
    by_id = {v['id']: v for v in json.loads((protocol / VECTOR_SOURCE).read_text())['receiverVectors']}
    picked = {'revision': REVISION, 'source': VECTOR_SOURCE}
    for vector_id, key in VECTORS:
        v = by_id[vector_id]
        picked[key] = {
            'id': vector_id, 'sourceChainId': v['sourceChainId'], 'sourceSafe': v['sourceSafe'], 'guard': v['guard'],
            'updateHead': v['bootstrap']['updateHead'], 'graph': v['bootstrap']['graph'],
            'encoded': v['bootstrap']['encoded'],
        }
    return json.dumps(picked, indent=2) + '\n'


def committed_source(protocol, path):
    original = (protocol / path).read_text()
    committed = subprocess.check_output(['git', '-C', str(protocol), 'show', REVISION + ':' + path], text=True)
    if original != committed:
        raise SystemExit('Refusing modified protocol source: ' + path)
    return original


def oft_pins(protocol):
    literal = re.search(r'OPTIONS_ATTRIBUTE = bytes4\(keccak256\("([^"]+)"\)\)', committed_source(protocol, LZ_MESSAGE))
    if literal is None:
        raise SystemExit(LZ_MESSAGE + ': no OPTIONS_ATTRIBUTE literal')
    proxy = json.loads((protocol / PROXY_ARTIFACT).read_text())['bytecode']
    if proxy['linkReferences']:
        raise SystemExit('Proxy initcode has unlinked libraries')
    initcode = bytes.fromhex(proxy['object'].removeprefix('0x'))
    return json.dumps({
        'revision': REVISION,
        'optionsAttribute': {'source': LZ_MESSAGE, 'string': literal.group(1),
                             'selector': '0x' + keccak256(literal.group(1).encode())[:8]},
        'proxyInitCodeHash': {'source': PROXY_ARTIFACT, 'hash': '0x' + keccak256(initcode)},
    }, indent=2) + '\n'


def generate(protocol):
    head = subprocess.check_output(['git', '-C', str(protocol), 'rev-parse', 'HEAD'], text=True).strip()
    if head != REVISION:
        raise SystemExit('Expected protocol revision ' + REVISION + ', found ' + head)
    outputs = {
        root / 'vectors/authority.json': vectors(protocol),
        root / OFT_PINS: oft_pins(protocol),
    }
    header = f'// Generated by scripts/sync-protocol.py; @crossecute/protocol {VERSION}, protocol {REVISION}.\n'
    abi = header + (
        'export { IConduitTransceiverAbi as conduitTransceiverAbi, '
        'ICrossecuteGuardAbi as crossecuteGuardAbi, '
        'ISourceAuthorityGuardAbi as sourceAuthorityGuardAbi, '
        'SafeBatchExecutorAbi as safeBatchExecutorAbi } from "@crossecute/protocol/abi";\n'
        f'export const PROTOCOL_VERSION = "{VERSION}";\n'
    )
    for export, profile, artifact_file, contract in ABIS:
        artifact = json.loads((protocol / f'contracts/{profile}/out/{artifact_file}.sol/{contract}.json').read_text())
        interfaces = [package_abi(protocol, name) for name in INTERFACES.get(export, [])]
        errors = [e for name in LIBRARY_ERRORS.get(export, []) for e in package_abi(protocol, name) if e['type'] == 'error']
        if export in ('lzOftTransmitterAbi', 'lzOftReceiverAbi'):
            errors += [e for e in package_abi(protocol, 'ILzOftConduitFactory') if e.get('name') == 'PeerChanged']
        entries = trim(export, merge_abis(*interfaces, errors, artifact['abi']))
        abi += 'export const ' + export + ' = ' + json.dumps(entries, separators=(',', ':')) + ' as const;\n'
    outputs[root / 'ts/src/signedAbi.ts'] = abi
    return outputs


if __name__ == '__main__':
    if sys.argv[1:] == ['--revision']:
        print(REVISION)
        raise SystemExit(0)
    args = [a for a in sys.argv[1:] if a != '--check']
    if len(args) != 1:
        raise SystemExit(__doc__)
    outputs = generate(pathlib.Path(args[0]).resolve())
    if '--check' in sys.argv:
        stale = [str(p.relative_to(root)) for p, text in outputs.items() if not p.exists() or p.read_text() != text]
        if stale:
            raise SystemExit('Out of date with protocol ' + VERSION + ' (' + REVISION + '): ' + ', '.join(stale))
        print('generated files match protocol ' + VERSION + ' (' + REVISION + ')')
    else:
        for path, text in outputs.items():
            path.write_text(text)
