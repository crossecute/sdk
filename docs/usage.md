# SDK usage guide

The [SDK overview](../README.md) explains the workflow. This guide covers setup,
transaction planning, verification, and Safe-signed dispatch.

## Install

```bash
pnpm add @crossecute/sdk @crossecute/protocol@0.2.0 viem @openzeppelin/contracts@5.4.0 @openzeppelin/contracts-upgradeable@5.4.0
```

With npm, use `npm install` with the same packages. The SDK is built against `@crossecute/protocol` 0.2.0, so install
that version and let both packages resolve one copy.

Foundry remappings:

```
@crossecute/sdk/=node_modules/@crossecute/sdk/contracts/
@crossecute/protocol/=node_modules/@crossecute/protocol/contracts/
@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/
@openzeppelin/contracts-upgradeable/=node_modules/@openzeppelin/contracts-upgradeable/
```

The project supplies `forge-std` itself. The sources need solc 0.8.28 or later. The SDK's
scripts never need `ffi`.

## Foundry

Extend `CrossecuteScript` and run the script with `--fork-url` (or `--rpc-url`) set to the home
chain.
[`script/Example.s.sol`](../script/Example.s.sol) is a complete script.

```solidity
_useHome(registry, transmitter);                            // the --fork-url chain; verifies the conduit
uint256 optimism = _useDestination(vm.envString("OPTIMISM_RPC_URL"));

_add(optimism, calls, new bytes[](0));                      // simulated as the receiver there
Plan memory plan = _plan();                                 // the owner's calls, run once as a check

_writeSafeTx(plan, nonce, "out/safe-tx.json");              // EIP-712 typed data for the owner Safe
_writePlan(plan, "out/plan.json");                          // batches and calls, for `crossecute check`
_writeSafeBatch(plan, "out/batch.json");                    // Safe Transaction Builder file
_broadcast(plan);                                           // owner is an EOA and the script's signer
```

What it checks:

- **The conduit.** `_useHome` reverts unless the registry's `predictTransceiver` for the
  transmitter's provider on this chain is the transmitter's transceiver, and that
  transceiver's `predictTransmitter(deployer, salt)` is the transmitter. Every later read
  (receiver, route, quote) trusts those two contracts, so a lookalike transmitter is refused
  before it can steer anything. The registry address is the trust anchor and comes from the
  script. A home chain whose CREATE2 is not `Predetermined` (zkSync, Tron) has no registry
  prediction and is refused.
- **The receiver.** Once bootstrapped, the receiver address comes from the transmitter's
  record. Before that, it comes from the home transceiver's `predictReceiver`. The SDK never
  derives it locally, because `Proxy`'s initcode hash depends on the compiler settings. A
  destination that reports its receiver back has no address until the report arrives, and
  `_add` reverts with `ReceiverNotPredictable`.
- **Simulation.** Each call runs from the receiver's address on the destination fork, in order,
  and later batches build on earlier ones. A call that reverts stops the script with
  `CallReverted(chainId, index, reason)`. If the receiver holds less than the batch's total
  value, `_add` reverts: a send cannot fund the receiver. Where the receiver is not deployed
  yet, a call back into it meets no code, so a callback the real receiver would refuse
  succeeds in simulation.
- **Gas.** With empty attributes a batch gets the provider's default delivery gas
  (`DeliveryGas`). The script logs a warning when the calls alone use more than that default.
  The default also pays the receiver's own overhead, so this is a floor, not a guarantee.
- **Bootstrap or send.** The first batch to a destination with no receiver becomes its
  `bootstrap`; later batches become `sendMessage`.
- **Fees.** The transmitter pays fees from its own balance. `_plan` quotes every call in order
  and sets `calls[0].value` to top the balance up to the total plus `feeBufferBps` (10% by
  default). Anything left over stays in the transmitter for later sends.
- **LayerZero's dead DVN.** On a plain `layerzero` conduit, `_add` reads the send ULN of the
  OApp that sends toward the destination from the endpoint and reverts when `0x…dEaD` is a
  required DVN: LayerZero's default for pathways it has not configured (every Fraxtal and zkSync
  pathway), on which every quote and send reverts. A bootstrap is the transceiver's send, so a
  dead transceiver config reverts `LzTransceiverDeadDvn(chainId, eid)`; governance pins it with
  `LzTransceiver.setDvn`, and the conduit's owner cannot. A message after the bootstrap is the
  conduit's own send, so its dead config reverts `LzDeadDvn(chainId, eid)`, and the owner must
  first call `LzTransmitter.setDvn(eid, required, optional, optionalThreshold)` with the stack
  they choose, in a Safe transaction of its own. The script does not pick a stack, and it passes
  once the endpoint reports one without the dead DVN. Other providers, `layerzero-oft` included,
  are not checked.
- **The home calls.** `_plan` runs them as the owner on the home fork, then restores the fork.
- **The Safe transaction.** One call goes as a direct `CALL`; several go through the
  MultiSendCallOnly for the Safe's `VERSION()`, taken from a table of known deployments
  (1.3.0, 1.4.1, 1.5.0) and used only if its code hash matches on the home chain. The nonce
  must not be below the Safe's. The SDK computes the `safeTxHash` itself and reverts unless the
  Safe's own `getTransactionHash` agrees. It logs the domain hash, message hash and
  `safeTxHash`.

## Forge Attest

`_writeSafeTx` writes Forge Attest's `safe-eip712` input. Forge Attest runs the script with
no arguments, so a script it reproduces reads its inputs from the environment, as the example
does. The file depends only on the plan,
the nonce and the home chain's state, so Forge Attest reproduces it byte for byte when the
claim pins the home block. Destination forks affect only the simulation verdict, not the
file; pass a block to `_useDestination` to make that repeatable too.

```toml
producer_repo   = "https://github.com/you/your-ops-repo"
producer_commit = "<40-hex commit sha>"
producer_setup  = "pnpm install --frozen-lockfile --ignore-scripts"

[[run]]
script     = "script/Example.s.sol:Example"
rpc_env    = "MAINNET_RPC_URL"
fork_block = "<home block>"
unclaimed  = ["out/example-plan.json"]

[run.env]
CROSSECUTE_REGISTRY    = "0x<registry>"
CROSSECUTE_TRANSMITTER = "0x<transmitter>"
OPTIMISM_TARGET        = "0x<target on Optimism>"
BASE_TARGET            = "0x<target on Base>"
NEW_OWNER              = "0x<new owner>"
SAFE_NONCE             = "<nonce>"

[run.defaults]
input_format = "safe-eip712"
safe_version = "1.4.1"

[[run.claim]]
output_path  = "out/example-safe-tx.json"
safe_network = "ethereum"
safe_address = "0x<owner Safe>"
safe_nonce   = "<nonce>"
expected_output_sha256 = "<sha256 of the file>"
expected_safe_tx_hash  = "0x<safeTxHash>"
```

Destination RPC URLs (`OPTIMISM_RPC_URL`, `BASE_RPC_URL` in the example) come from the
environment `attest.sh` runs in. Each owner then signs and proposes or confirms with
`./attest.sh --config attest.toml --attest -- --ledger`, which never sees the key. Check the
claim fields against the Forge Attest version you pin; this example follows v1.4.0.

In an npm-based producer repository, set `producer_setup` to `npm ci --ignore-scripts`.

`pnpm run test:attest` runs Forge Attest v1.4.0's own reader and hash derivation over the
typed data the tests write, and checks the hash matches the SDK's.

## TypeScript

```ts
import { parsePlan, checkPlan, parseSafeTxTypedData, checkSafeTx, safeTxHashes, encodeEvm, encodeCalls, chainKey } from "@crossecute/sdk";
```

`parsePlan` reads unsigned integers as decimal strings within `uint256` and normalizes
complete hex bytes to lowercase. `checkPlan` re-derives each home call from its batch and
throws if the calldata differs.
`checkSafeTx` throws unless the typed data is the one Safe transaction that carries the plan:
the owner Safe's domain on the home chain, no gas refund, and the plan's call directly or all
of its calls through a known MultiSendCallOnly.

```bash
pnpm exec crossecute check out/plan.json out/safe-tx.json
```

The command prints the batches, then the domain hash, message hash and `safeTxHash` a signer's
device shows. Its only runtime dependency is `@crossecute/protocol`. viem is a peer dependency
(`^2.57.18`), so a frontend keeps the single copy it already has.
In an npm project, run the installed CLI with `npx crossecute check out/plan.json out/safe-tx.json`.

## Development

Use Node.js 22.13 or later with the pnpm version pinned in `package.json`.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test             # forge test, then vitest
pnpm run typecheck
pnpm run test:attest  # needs network access, jq and cast
```

For npm, run `npm ci --ignore-scripts` and use `npm test` or `npm run <script>`.
CI tests both installers. When dependencies change, update both lockfiles with
`pnpm install --lockfile-only --ignore-scripts` and
`npm install --package-lock-only --ignore-scripts`.

`test/Vectors.t.sol` writes `vectors/` from the protocol's own Solidity encoders and the
SDK's MultiSendCallOnly table, and the TypeScript tests check their copies against it. The
TypeScript tests also read files the Foundry tests write under `out/`, so run `forge test`
first.

## Safe-signed dispatch

The signed API is built against `@crossecute/protocol` 0.2.0. It includes `SafeTxEvidence { signedSafeTx,
nestedApprovals }`, `SignedSafeTx`, `NestedSafeApproval`, `AuthorityGraph`, execution leaves,
`SignedBootstrap`, and the current transmitter, receiver (including nonce and authority views), transceiver,
guard, and `SafeBatchExecutor` ABIs, trimmed to the functions and events the builders and this document use
plus every custom error, so reverts decode; inherited access-control and admin members are omitted. The
Solidity types come from the package's sources. `scripts/sync-protocol.py` generates `ts/src/signedAbi.ts`,
`vectors/authority.json` and `vectors/lzoft-protocol.json` from the release's tagged commit, CI regenerates
them and fails on a difference, and `ts/test/protocolRelease.test.ts` fails if the dependency, the pinned
version and revision, and the generated files disagree.
The existing plain planner and `crossecute check` still handle plain plans only.

### Authority model

A signed conduit and a plain conduit of one provider share one salt, `keccak256(abi.encode(owner,
userSalt, homeChainKey))` for the registry providers and the six-field salt of
[LayerZero OFT conduits](#layerzero-oft-conduits) for that binding, so no address commits to the
owner's authority and an ownership change moves no address. The mode is fixed when the transmitter is
created. Obtain addresses from the deployed transceiver (`predictConduit`, `predictReceiver(chainKey,
owner, salt)`) or, for an OFT conduit, the deployed factory, never from local compiler initcode. `transceiverExtensionAbi.signedAuthority(owner)` returns the owner's
live records and is only the creation-time mode probe; no creation records are stored.

The owner Safe activates its authority with the source guard, which stores the selected
`updateHead` and the hash of the selected graph. A bootstrap carries that head and graph to
each destination. The graph is an `AuthorityGraph`: nodes in canonical depth-first order from
the owner Safe, each a `SafeAuthorityRecord` (threshold and owners in `getOwners()` order, kind
`0` for an EOA and `1` for a nested Safe) with a `position`, zero for the root and the selected
update head of that Safe for each descendant. Each Safe has at most 16 immediate owners.
`authorityGraphHash(sourceChainId, graph)` is the value the guard stores as
`selection(safe).authorityHash` and a bootstrap must match.

Each receiver stores the head and graph its own bootstrap carried, on the provider's and source
transceiver's authentication, and advances only through authority updates submitted to it.
Owners can read `selection()` and `graph(selection().authorityHash)` on a receiver before relying
on it. Each receiver starts at the head in its authenticated bootstrap and advances one signed
successor at a time.

### Authority proposals

Use `AuthoritySource` with a source RPC, guard address, pinned block, and earliest possible
guard block. `planAuthorityProposal(source, input)` retrieves the selected graph, checks
its hash against the guard, and resolves forward proofs for retained child Safes. The
input names the Safe, nonce, new graph and action (`activate`, `ownership`, or `adopt`).
For ownership changes, supply the guard's pinned MultiSendCallOnly and the ordered Safe
owner mutations. Activation starts with an empty current witness. Historical activation
witnesses are recovered from the transaction input for the supported Multicall3 entry
points. Successor witnesses and catch-up proofs come from `AuthorityPublished` logs,
verified against the guard's publication hash. The RPC must serve this history.

The proposal exposes the same `SafeTxEnvelope` and `serializeSafeTxTypedData` as other SDK
operations. Once signed, call `prepareAuthorityExecution` with the portable signatures,
any nested approvals, and the normal signing callback for the live Safe. It checks the
portable signatures against the live Safe first and requests live signatures only if the
check reverts. It keeps the original portable evidence and simulates the complete atomic
call. Submit the returned transaction to the configured Multicall3, which stages the
witness and executes the Safe in one transaction. The Safe UI can collect signatures.
Execution must use the staged call because the witness exists only inside that transaction.

A parent Safe keeps each child at the position the parent selected. `staleAuthorityChildren`
reports newer positions without modifying the parent's snapshot. Use an `adopt` proposal
to advance the parent to the chosen child positions before dispatching under the new
authority. A rejected or replaced source proposal does not revoke portable approvals.
Portable approvals have no expiry. A receiver that still selects its predecessor can accept
a valid signed update directly.
A receiver accepts the first valid successor of its own head.

### Authority catch-up with Forge Attest

`planAuthorityCatchUp` checks the source-to-receiver route and walks the verified source
publications back to the receiver's head. Use the returned envelope for the next
`relayAuthority` call. The source Safe pays the provider fee, and the receiver applies
the update on provider delivery. Use `authorityRelayDelivered` to check the expected
receiver head and graph hash. Re-plan after delivery for each remaining update. A
source relay receipt alone does not establish destination delivery. Direct submitters can
encode an ordered, atomic destination batch with `submitAuthorityBatchData`. For independent
receivers, `scaffoldAuthorityRelayBatch` generates a single Safe proposal using a CALL to
Multicall3 with one successor per receiver. The batch pins the exact native value of each
call, and the generated script rejects relays that differ in source chain, Safe or nonce.
Requote if provider fees change before execution.

Run `crossecute authority-relay relay-config.json relay-files` to generate a Forge producer
script and an `attest.toml` for the next relay proposal. Set the named RPC environment
variables and provide this configuration with your own chain state and addresses.

```json
{
  "sourceRpcEnv": "MAINNET_RPC_URL",
  "destinationRpcEnv": "BASE_RPC_URL",
  "sourceBlock": "22000000",
  "destinationBlock": "27000000",
  "guardFromBlock": "21000000",
  "guard": "0x0000000000000000000000000000000000000001",
  "safe": "0x0000000000000000000000000000000000000002",
  "nonce": "42",
  "transmitter": "0x0000000000000000000000000000000000000003",
  "receiver": "0x0000000000000000000000000000000000000004",
  "attributes": [],
  "producerRepo": "https://github.com/your-organization/ops",
  "safeNetwork": "ethereum"
}
```

Put the generated `script/RelayAuthority.s.sol` in the ops repo with the SDK and Forge
installed, commit it, and set `producer_commit` in the generated claim to that commit.
The generated setup command assumes a pnpm lockfile. Set `producer_setup` to the ops repo's
dependency installation command if it uses a different package manager.
The script checks the selected receiver head and graph hash at the pinned destination
block and reproduces the source fee quote and Safe transaction on the pinned source fork.
Forge Attest checks the regenerated Safe transaction hash. Run the claim using the
normal Forge Attest signing flow. Check the live destination head again before sending
a later relay.

### Standalone sends and direct delivery

```ts
import {
  encodeEvm, encodeCalls, signedSendData, signedDispatchTx,
  serializeSafeTxTypedData, submitMessageData, signedTransmitterAbi,
  type SafeTxEvidence,
} from "@crossecute/sdk";

// Discover and verify the conduit and receiver from deployed contracts first.
// Use explicit provider gas attributes based on simulation of the complete entry point.
const data = signedSendData(encodeEvm(destinationChainId, receiver), encodeCalls(calls), attributes);
const envelope = signedDispatchTx(homeChainId, ownerSafe, transmitter, safeNonce, data);
const typedDataFile = serializeSafeTxTypedData(envelope); // write for Forge Attest / cast
// Collect owners' signatures externally over this exact transaction and source-chain domain.
const evidence: SafeTxEvidence = {
  signedSafeTx: { safeTx: envelope.tx, signatures },
  nestedApprovals, // exact cached child signMessage transactions, including approvals at any depth
};
const fee = await client.readContract({
  address: transmitter, abi: signedTransmitterAbi,
  functionName: "quoteSignedMessage", args: [evidence],
});
const directCalldata = submitMessageData(evidence); // permissionless receiver submission
```

`encodeStandaloneWire` returns `abi.encode(1, evidence)`. Keep the signed transaction's
calldata and signature blob byte for byte, including any policy extension; the guard's
`consume` returns an empty `safeTx.data`, which must be restored from the original Safe
transaction. Cached nested approvals use the child's source-chain Safe message domain;
`safeMessageHash` computes that hash. The SDK does not fetch cached approvals or authenticate
signatures. Quotes can collect additional live approvals; deployed contract state is the
authority for source transport.

A complete valid bundle can execute directly at the receiver **before the source transaction
executes**. Replacing/canceling the source transaction does not revoke it. A receiver verifies
signatures against the authority graph it has selected, which may differ from the live owners
until its authority updates are submitted.

Signed sends must be individual Safe **CALL** transactions with zero `safeTxGas` and
`gasPrice`. Each has its own Safe nonce; do not use the plain planner's MultiSend transaction.
`safeBatchData([{ envelope, signatures }, ...])` encodes atomic source submission through
`SafeBatchExecutor`, checking source-chain consistency and consecutive nonces for each Safe.
The first nonce must match the Safe's live nonce at execution. The executor supplies no ETH;
fund the Safe/transmitter separately, or include the required transmitter top-up in the
Safe transaction's signed `value` before collecting signatures. Changing it requires new signatures.

### Published trees, relay and direct delivery

```ts
import {
  encodeExecutionLeaf, dispatchTree, publishLeavesData,
  registerRootData, relayLeafData, submitLeafData,
} from "@crossecute/sdk";

const published = executionLeaves.map(encodeExecutionLeaf);
const tree = dispatchTree(published);
const publishCalldata = publishLeavesData(published); // anyone calls the owner's guard
const registrationCalldata = registerRootData(tree.root); // nonpayable; sign a separate Safe CALL
const relayCalldata = relayLeafData(registrationEvidence, executionLeaves[0], tree.proofs[0]);
const directCalldata = submitLeafData(registrationEvidence, executionLeaves[0], tree.proofs[0]);
```

Publication encodes a leaf's **fields**, not an offset-prefixed ABI tuple. Hashes are double
keccak; siblings are sorted, leaves stay in publication order, and odd last nodes move up
unchanged. `dispatchTree` returns proofs by original index; `verifyDispatchProof` checks them.
`executionId` excludes attributes while `executionLeafHash` includes them. Execution nonces
are local to each receiver. Windows are inclusive destination
block times: `validAfter <= timestamp <= deadline` (zero deadline is not unlimited).

`registerRoot` requires prior guard publication on the source. A source relay additionally
requires the root registered on that transmitter, unused leaf state, live quorum and a valid
route. Direct receiver submission verifies the signed registration/proof independently of
source registration or publication. It shares replay state with provider delivery.

Quote relay fees with `signedTransmitterAbi.quoteRelay` using the **funding relayer's account**,
then pay from that same account when calling `relayLeaf`; recipient-sensitive provider quotes
must match the sender. Excess and synchronous refunds return to the relayer; the transmitter's
prefunded balance is preserved. Top-ups for direct submissions remain at the receiver,
including authenticated duplicates. `encodeStandaloneWire` and `encodeMerkleWire` build the
exact transport encodings, including nested approvals.

### Signed bootstrap

```ts
import {
  encodeCalls, encodeEvmChain, signedBootstrapData, authorityGraphHash,
} from "@crossecute/sdk";

// selection is guard.selection(ownerSafe); authority is the graph that hashes to selection.authorityHash.
if (authorityGraphHash(homeChainId, authority) !== selection.authorityHash) throw new Error("not the selected graph");
const data = signedBootstrapData(
  encodeEvmChain(destinationChainId),
  { guard, updateHead: selection.updateHead, authority, setupCalls: encodeCalls(setupCalls) },
  ownerSafe,
  attributes,
);
const envelope = signedDispatchTx(homeChainId, ownerSafe, transmitter, safeNonce, data);
```

`bootstrap(payload, attributes)` is a separate Safe CALL like any signed send. Its payload is
`Payload.encodeBootstrap(destinationChainIdentifier, abi.encode(SignedBootstrap(guard, updateHead,
abi.encode(graph), setupCalls)))`, and `setupCalls` is `abi.encode(Call[])`. Both quote and send
require `guard` to be the Safe's installed guard and the head and graph hash to equal its
selection, and the Safe must have activated first. Price it with
`signedTransmitterAbi.quoteBootstrap(payload, attributes)`, which validates the same body.
`signedBootstrapData(destination, body, owner, attributes)` and `encodeSignedBootstrap(body, owner)`
reject a zero head and run `validateAuthorityGraph(graph, owner)`, which checks what the receiver
checks of the body's shape: `owner` as the root at position zero (a graph canonical for another
Safe is rejected), nonzero descendant positions, canonical depth-first order without cycles,
duplicates or unreachable nodes, valid thresholds and owner kinds, and at most 16 owners per Safe.
They cannot check the head, the graph hash or positions against the guard; compare
`authorityGraphHash` with the guard's selection as above. The Foundry `SignedDispatch.bootstrapBody`
validates nothing. Signatures prove nothing about a carried graph, so the destination trusts the provider
and the source transceiver for it. A failed source transport reverts the Safe's bootstrap
execution and the Safe can sign another; a second delivery to an existing receiver reverts.
Bootstrap carries no historical updates.

There is no signed zkSync/Tron path here; signed LayerZero OFT conduits are covered by [their own
section](#layerzero-oft-conduits). Provider payload sizing and gas must
include signatures, nested verification, proof and receiver work. The inherited 200k payload /
1m bootstrap defaults do not cover general signed delivery. These encoders do not certify a
live provider cap, fee, simulation result, signature quorum or destination state.

### Foundry signed builders

`SignedDispatch` supplies the same field encodings, Merkle root and per-leaf proofs
(`SignedDispatch.proof`), standalone/bootstrap/root calldata, wire bodies, relay and direct-submission calldata.
`bootstrapBody(guard, updateHead, graph, setupCalls)` and `bootstrapData(destinationChainIdentifier, body,
attributes)` build the bootstrap of the previous section without validating the graph. Import `ExecutionLeaf`,
`SafeTxEvidence`, and `NestedSafeApproval` from
`@crossecute/protocol/messaging/signed/types/SignedDispatchTypes.sol` and `AuthorityGraph` from
`@crossecute/protocol/messaging/authority/AuthorityGraph.sol`; `SafeTx` in `Types.sol` re-exports
the shared guard type. Build individual signed transactions with
`SignedDispatch.transaction(transmitter, nonce, data, value)`, hash with `SafeTxHash`, and
write Forge Attest input with `PlanJson.safeTxTypedData(homeChainId, ownerSafe, tx)`.
Simulate receiver calls and full provider entry points against pinned forks separately;
`CrossecuteScript._plan` is the plain-mode planner.

`test/SignedDispatch.t.sol` writes committed Solidity reference vectors for hashes, nested
wire encodings, calldata and atomic batches. `vectors/authority.json` holds two of protocol's own
#109 bootstrap vectors, copied at the pinned revision by the sync script; Solidity and TypeScript
both reproduce their encoded body, and TypeScript their record and graph hashes. TypeScript
verifies parity against those vectors, plus odd tree sizes, tampering, replay identities,
graph validation and source nonce order.
`test/MerklePackage.t.sol` writes `vectors/merkle.json` (trees of 1, 2, 3, 5, 8 and 9 leaves and
a tree over several receivers) and checks the protocol guard's cast-computed three-leaf root and
leaf hashes. TypeScript builds the same trees and compares every encoded leaf, hash, root and proof.
`test/MerklePackageJson.t.sol` writes `vectors/merkle-package-guard5.json` and
`vectors/merkle-package-multi.json` with `MerklePackageJson`; TypeScript parses and verifies each file
and re-serializes it to the same bytes.

### Merkle package and delivery bundle

`buildMerklePackage(leaves, receiverNonces)` produces the root, leaf hashes and proofs that the
guard's `publishLeaves` records for the same ordered leaves, as a `MerklePackage` with
`version: 1`. `merklePublishData(pkg)` is the `publishLeaves` calldata; each entry's `hash` is the
indexed hash of its `LeafPublished` event, and `registerRootData(pkg.root)` is the owner Safe's
registration. A plan is rejected when it holds a duplicate leaf, two different batches at one
receiver nonce (the receiver's conflicting-batch revert), a nonce below the receiver's observed
`nextNonce`, or receiver nonces that are missing, repeated or unused. One batch at one nonce with
different attributes is allowed, as the receiver records execution IDs without attributes.
`verifyMerklePackage` rebuilds the tree from the leaves and checks every recorded root, hash and
proof; the leaf order is part of the package.

A Foundry script drafts the same package by extending `MerklePackageScript`, which extends
`CrossecuteScript`: it runs on the home chain, forks each destination, and writes the file the other
owners review and `parseMerklePackage` reads. The receiver comes from the transmitter, as in the plain
planner, and its `nextNonce` is read on the destination fork, so a script names neither.

```solidity
_useHome(registry, transmitter);
uint256 optimism = _useDestination(vm.envString("OPTIMISM_RPC_URL"));

_addLeaf(optimism, 0, deadline, calls, new bytes[](0));     // next free nonce, simulated as the receiver
MerklePackage memory pkg = _merklePackage();                // checks the plan, builds root, hashes, proofs
_writeMerklePackage(pkg, "out/merkle.json");

bytes memory data = MerklePackages.registerData(pkg);       // the owner Safe's signed CALL
SafeTx memory t = SignedDispatch.transaction(address(transmitter), safeNonce, data, 0);
vm.writeFile("out/register-root.json", PlanJson.safeTxTypedData(block.chainid, transmitter.owner(), t));
```

`_addLeaf` takes the transmitter's recorded receiver once the destination is bootstrapped and the
registry-derived prediction before. It reads the receiver's `nextNonce()` the first time a chain is used
and reuses that value for every later leaf, so one package never mixes blocks. A receiver that is not yet
deployed starts at nonce 0, and a deployed receiver without `nextNonce()` reverts with
`ReceiverNonceUnreadable`. Each leaf's calls run as the receiver on the destination fork and keep their
effects, so a later leaf simulates on top. `_addLeaf(chainId, nonce, ...)` queues the same batch at a
given nonce under other attributes; later free nonces follow it. The helper covers EVM destinations.
For any other leaf, call `MerklePackages.build` with the leaves and observed receiver nonces directly.

`MerklePackages.build` applies the plan rules above and reverts with `DuplicateLeaf`,
`ConflictingNonce`, `StaleNonce`, `MissingReceiverNonce`, `UnusedReceiverNonce` or
`DuplicateReceiverNonce`. `MerklePackageJson.toJson` writes the TypeScript layout (decimal-string
integers, lowercase hex, `version: 1`). `MerklePackages.publishData(pkg)` is the guard's
`publishLeaves` calldata. As with `CrossecuteScript`, a receiver that is not yet deployed meets no code
in simulation, so a callback into it that it would refuse succeeds there.

### Propose, confirm and export through Safe Queue

Build the standalone or Merkle `envelope` as above and save an unsigned bundle. For a Merkle
registration, pass the same `merkle` package to everyone signing so they can inspect the calls
and verify the root in the queued transaction.

```ts
writeFileSync("unsigned-bundle.json", serializeDeliveryBundle(
  buildDeliveryBundle({ envelope, signatures: "0x", merkle }),
));
```

Install `cast` and connect the Ledger for the owner address used in each command. Set
`SAFE_API_KEY` for authenticated access to the [Safe Queue Service](https://docs.safe.global/core-api/safe-queue-service-overview).
Share the unsigned bundle with the other owners. The proposal appears in the Safe{Wallet} queue.
Each owner reviews the destination calls and uses the SDK signing command so they see and
acknowledge the destination execution notice before the Ledger signs.

```bash
crossecute signed-propose unsigned-bundle.json "$OWNER_A"
crossecute signed-confirm unsigned-bundle.json "$OWNER_B"
crossecute signed-export unsigned-bundle.json "$OWNER_A" "$OWNER_B" > delivery.json
```

The export arguments identify the EOA owners whose signatures form quorum on the target
receiver. Check the receiver's stored authority before choosing them. Export verifies the
individual signatures against the exact queued Safe transaction and packs them in Safe owner
address order. This queue workflow accepts typed-data and Safe `eth_sign` EOA signatures.
For nested Safe signatures, assemble the full Safe signature blob and any nested evidence with
the existing bundle builder. The receiver checks the actual quorum and execution conditions.

An independent submitter can load `delivery.json` with `parseDeliveryBundle`, build calldata
with `submitMessageFromBundle(bundle)` or `submitLeafFromBundle(bundle, index)`, and send it
directly to the bootstrapped receiver named in the standalone message or leaf. The queue
workflow performs off-chain proposal and confirmation requests. Direct submission can succeed
while the source transaction is still pending and the bridge is offline.

For another signing interface, use `SafeQueue.propose` and `SafeQueue.confirm` with a
`SafeQueueSigner`. Its `acknowledge` callback must present the notice and return the owner's
decision. The SDK calls `signTypedData` only after the owner accepts. Use the SDK signing path
for every owner to get the acknowledgment. Safe{Wallet}'s built-in confirmation screen runs
its own signing flow.

### LayerZero OFT conduits

The `layerzero-oft` binding sends every message through an OFT its own team operates, from the
conduit itself, and a factory with no owner creates the conduit at home and its receiver on each
destination. Its rules are protocol's
[`docs/providers/layerzero-oft-spec.md`](https://github.com/crossecute/protocol/blob/npm-v0.2.0/docs/providers/layerzero-oft-spec.md)
(L1 to L5 and the OFT prerequisites O1 to O7). The signed entry points are the ones of the sections
above and are unchanged: `signedSendData`, `registerRootData`, `relayLeafData`, `submitLeafData`,
`submitMessageData`, `signedBootstrapData`, the Merkle package and the delivery bundle. The OFT
transmitter implements the same signed bootstrap hooks as every signed transmitter, and the factory's
`signedConduitBootstrap` builds the destination envelope on chain from the body
`signedBootstrapData` encodes. What is OFT specific is the options attribute and conduit creation.

```ts
import {
  chainKey, encodeCalls, encodeEvm, encodeEvmChain, lzOftCreateTx, lzOftLeaves, lzOftRoot, lzOptionsAttribute,
  predictLzOftConduit, signedBootstrapData, signedSendData,
} from "@crossecute/sdk";

// Peers of the home OFT, one per destination; the factory reads them, the SDK does not.
const home = { chainKey: chainKey(homeChainId), eid: homeEid };
const leaves = lzOftLeaves(destinations, home); // [{ chainId, eid, oft }], sorted by chain key
const destRoot = lzOftRoot(leaves, home);
// proxyInitCodeHash is the deployed factory's PROXY_INIT_CODE_HASH() (lzOftConduitFactoryAbi).
const conduit = predictLzOftConduit(factory, { owner: ownerSafe, salt, homeChainKey: home.chainKey, homeEid, homeOft, destRoot }, proxyInitCodeHash);
// Compare with `predictConduit` on the deployed factory before relying on it.
const creation = lzOftCreateTx(homeChainId, ownerSafe, factory, safeNonce, salt, homeOft, leaves); // Safe CALL

const attributes = [lzOptionsAttribute(rawOptions)];
const send = signedSendData(encodeEvm(destinationChainId, conduit), encodeCalls(calls), attributes);
const bootstrap = signedBootstrapData(encodeEvmChain(destinationChainId), body, ownerSafe, attributes);
```

**The one attribute.** The conduit accepts only `abi.encodePacked(OPTIONS_ATTRIBUTE, rawOptions)` with
`OPTIONS_ATTRIBUTE = bytes4(keccak256("crossecute.lz.options"))`, and at most one attribute per send.
`lzOptionsAttribute(rawOptions)` and the Foundry `LzOft.optionsAttribute(rawOptions)` build it. The raw
options replace the default lzCompose option whole, so they must carry the compose gas the destination
needs. Protocol reads an attribute with no options as present and empty, not as "use the defaults", so
both builders reject empty options and odd-length hex; the content is not otherwise validated. Any other
attribute reverts.

**Creation.** `createTransmitter(salt, homeOft, leaves)` is called by the owner Safe, which becomes the
conduit's owner. Each leaf is `{ chainKey, eid, oft }`: a destination, its endpoint id and the home
OFT's peer there. The factory hashes each leaf twice (`lzOftLeafHash`), builds the destination root
over the leaf hashes in the order given, and binds `keccak256(abi.encode(owner, salt, homeChainKey,
homeEid, homeOft, destRoot))` into the CREATE2 salt, so the address changes with any of them. Leaves
must be in strictly ascending `chainKey` order, which is a hash order and not the chain id order, and a
repeated chain key is refused. `lzOftLeaves` sorts by chain id for you; `lzOftRoot`,
`checkLzOftLeaves` and `createLzOftTransmitterData` reject unsorted input with the factory's
`LeavesNotSorted(index)`, and also reject no leaves, a zero eid or OFT, and, given the home, a leaf for
the home chain or the home's eid. The Foundry `LzOft` library offers the same checks, root, calldata and
prediction (`LzOft.root`, `createTransmitterData`, `predictConduit`) for leaves already in order.
Destinations are fixed at creation: another chain needs another conduit.

This creation path serves plain and signed conduits alike, and the factory fixes the mode at creation
from the owner Safe's guard (`SafeViewer.isSigned`): the Crossecute guard must already be installed on
the Safe when the creation transaction executes, or the conduit is plain and stays plain. The signed
bootstrap further needs the guard's authority activated. The SDK cannot read the Safe's guard without
an RPC, so it does not check this; read the guard slot before signing and `isSigned(conduit)` on the
factory afterwards. Plan and simulate plain OFT conduits elsewhere: `CrossecuteScript` resolves a
conduit through the registry, in which this binding has no route.

**Addresses.** `predictLzOftConduit` and `LzOft.predictConduit` take the factory address, which is the
same on every chain it is deployed to, and `proxyInitCodeHash`, which is required. Pass the deployed
factory's `PROXY_INIT_CODE_HASH()`: it is what the factory's own `predictConduit` hashes, and a different
build of `Proxy` gives different addresses. `LZ_OFT_PROXY_INIT_CODE_HASH` and `LzOft.PROXY_INIT_CODE_HASH`
are the pinned protocol revision's value, taken from protocol's own build artifact, for tests and for
checking the deployed one. The conduit's receiver is at the conduit's own address on every destination:
the factory's `predictReceiver` returns the calling conduit, so the recipient of a send is
`encodeEvm(destinationChainId, conduit)`.

**Sends carry no tokens.** The conduit sets `amountLD` and `minAmountLD` to zero for every send and
bootstrap (L3.1), so a send moves only its fee, paid from the conduit's balance like any signed send.
Nothing here builds a `SendParam`.

**Signed bootstrap size is lane specific.** The graph and the setup calls in the body are variable
size, and the destination envelope adds the home fields and proof, so its size and compose gas depend on
the lane and the authority. The default compose gas the transmitter sends with is not a bound for it.
Measure the lane, quote with `quoteBootstrap`, and pass an options attribute with the gas it needs
(protocol #118 tracks fee, gas and payload caps).

**Prerequisites the SDK does not check.** A conduit must not be created on an OFT that fails one of
these, and nothing here reads chain state:

- O1: `send` writes the caller as `composeFrom`.
- O2: the OFT is peered both ways with every destination's OFT. Peers are checked at creation and at
  each send, by the contracts.
- O3: its enforced options for a send with a compose message carry lzReceive gas.
- O4: it accepts a send of 0 tokens.
- O5: its `lzReceive` is unordered.
- O6: every chain involved is a `parity` chain in protocol's `deploy/chains.toml`, so the factory has one
  address.
- O7: the conduit's own team operates the OFT, since its owner, delegate and upgrade admin can stop the
  conduit's channel.

`deploy/CHECKS.md` section 7 in protocol says how to check each. An eid that belongs to another chain
than its leaf's is not caught at creation either; that destination's bootstrap fails.

**Not covered.** Live fee, gas, compose gas and payload cap
validation (protocol #118); building the destination compose, which the factory does; planning plain
OFT conduits; zkSync and Tron, whose CREATE2 formulas place the conduits elsewhere.

`vectors/lzoft.json`, written by `test/LzOft.t.sol`, holds the leaf hashes of 11 destinations, roots of
1, 2, 3, 4, 5, 8, 9 and 11 leaves, and the calldata, salt and address of a conduit with 5, which
both languages reproduce. `vectors/lzoft-protocol.json` holds the options selector and `Proxy` initcode hash the pinned protocol gives, and the CI `protocol-pin` job
runs protocol's `LzOftMessage`, `LzMessage` and `LzOftConduitFactory` over `vectors/lzoft.json` with
`scripts/check-lzoft-vectors.py`, as protocol has no literal OFT vectors of its own.
