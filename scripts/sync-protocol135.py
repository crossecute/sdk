"""Refresh the unreleased protocol #135 compatibility snapshot from an exact checkout + Forge artifacts.

Usage: sync-protocol135.py [--check] /path/to/protocol

The revision below is the single source for the snapshot: the script writes it to the manifest, the
generated ABI header and `PROTOCOL_135_REVISION`; ts/test/protocol135.test.ts compares all of them.
`--check` regenerates in memory and fails if any committed file differs.
"""
import hashlib, json, pathlib, re, shutil, subprocess, sys

REVISION = '3169f8cb72721330ec0af7b0235eeaf6877b9c74'
REPOSITORY = 'https://github.com/crossecute/protocol'
root = pathlib.Path(__file__).resolve().parents[1]
vendor = root / 'contracts/vendor/protocol135'

# Protocol path -> vendored file name. Only import specifiers are rewritten.
FILES = {
    'contracts/safe-guard/src/ICrossecuteGuard.sol': 'ICrossecuteGuard.sol',
    'contracts/safe-guard/src/SafeHashes.sol': 'SafeHashes.sol',
    'contracts/safe-guard/src/SafeBatchExecutor.sol': 'SafeBatchExecutor.sol',
    'contracts/evm/src/messaging/signed/types/SafeAuthorityTypes.sol': 'SafeAuthorityTypes.sol',
    'contracts/evm/src/messaging/signed/types/SignedDispatchTypes.sol': 'SignedDispatchTypes.sol',
    'contracts/evm/src/messaging/authority/AuthorityGraph.sol': 'AuthorityGraph.sol',
    'contracts/evm/src/messaging/signed/DispatchLeaves.sol': 'DispatchLeaves.sol',
    'contracts/evm/src/messaging/outbound/ISignedTransmitter.sol': 'ISignedTransmitter.sol',
    'contracts/evm/src/messaging/inbound/ISignedReceiver.sol': 'ISignedReceiver.sol',
}
# (exported name, Forge profile directory, artifact file, contract)
ABIS = [
    ('signedTransmitterAbi', 'evm', 'SignedTransmitter', 'SignedTransmitter'),
    ('signedReceiverAbi', 'evm', 'SignedReceiver', 'SignedReceiver'),
    ('transceiverExtensionAbi', 'evm', 'TransceiverExtension', 'TransceiverExtension'),
    ('transceiverBaseAbi', 'evm', 'TransceiverBase', 'TransceiverBase'),
    ('conduitTransceiverAbi', 'evm', 'TransmitterBase', 'IConduitTransceiver'),
    ('crossecuteGuardAbi', 'safe-guard', 'ICrossecuteGuard', 'ICrossecuteGuard'),
    ('safeBatchExecutorAbi', 'safe-guard', 'SafeBatchExecutor', 'SafeBatchExecutor'),
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
                      'quoteSignedMessage', 'quoteRelay', 'quoteAuthority', 'relayLeaf', 'relayAuthority', 'registerRoot',
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
                      'SIGNED_BOOTSTRAP'],
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
IMPORT = re.compile(r'"(?:@crossecute/safe-guard/|src/messaging/signed/types/|\.\./signed/types/)([^"/]+)"')
IMPORT_AUTHORITY = re.compile(r'"src/messaging/authority/([^"/]+)"')


def keccak256(data):
    """Keccak-256 through Foundry's `cast`, which hashlib has no digest for. CI installs Foundry; locally
    `cast` is on PATH or in ~/.foundry/bin."""
    cast = shutil.which('cast') or str(pathlib.Path.home() / '.foundry/bin/cast')
    return subprocess.check_output([cast, 'keccak', '0x' + data.hex()], text=True).strip().removeprefix('0x')


def sha256(text):
    return hashlib.sha256(text.encode()).hexdigest()


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
    outputs = {}
    manifest = {'repository': REPOSITORY, 'revision': REVISION, 'sources': {}, 'vendored': {}}
    for source, name in FILES.items():
        original = (protocol / source).read_text()
        committed = subprocess.check_output(['git', '-C', str(protocol), 'show', REVISION + ':' + source], text=True)
        if original != committed:
            raise SystemExit('Refusing modified protocol source: ' + source)
        text = IMPORT_AUTHORITY.sub(r'"./\1"', IMPORT.sub(r'"./\1"', original))
        outputs[vendor / name] = text
        manifest['sources'][source] = sha256(original)
        manifest['vendored'][name] = sha256(text)
    outputs[root / 'vectors/authority.json'] = vectors(protocol)
    outputs[root / OFT_PINS] = oft_pins(protocol)
    outputs[vendor / 'manifest.json'] = json.dumps(manifest, indent=2) + '\n'
    header = f'// Generated by scripts/sync-protocol135.py; protocol {REVISION}.\n'
    abi = header + f'export const PROTOCOL_135_REVISION = "{REVISION}";\n'
    for export, profile, artifact_file, contract in ABIS:
        artifact = json.loads((protocol / f'contracts/{profile}/out/{artifact_file}.sol/{contract}.json').read_text())
        abi += 'export const ' + export + ' = ' + json.dumps(trim(export, artifact['abi']), separators=(',', ':')) + ' as const;\n'
    outputs[root / 'ts/src/signedAbi.ts'] = abi
    return outputs


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--check']
    if len(args) != 1:
        raise SystemExit(__doc__)
    outputs = generate(pathlib.Path(args[0]).resolve())
    if '--check' in sys.argv:
        stale = [str(p.relative_to(root)) for p, text in outputs.items() if not p.exists() or p.read_text() != text]
        if stale:
            raise SystemExit('Out of date with protocol ' + REVISION + ': ' + ', '.join(stale))
        print('snapshot matches protocol ' + REVISION)
    else:
        for path, text in outputs.items():
            path.write_text(text)
