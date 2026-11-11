# @crossecute/sdk

Foundry and TypeScript helpers for running calls on a Crossecute conduit's receivers. A
Foundry script runs on the conduit's home chain, simulates each batch as the receiver on a
fork of its destination, and turns the batches into one Safe transaction for the owner. It
writes that transaction as the EIP-712 typed data owners sign, which
[Forge Attest](https://github.com/crossecute/forge-attest) reproduces from the script, then
signs and proposes. The TypeScript side checks the same files and gives a frontend the
protocol's encoders.

The SDK holds no keys and sends nothing to a Safe Transaction Service. Signing and proposing
belong to Forge Attest, `cast wallet sign`, or the Safe UI.

The Foundry planner covers plain `sendMessage` and `bootstrap` from an owner Safe or EOA.
The signed builders support [protocol PR #135](https://github.com/crossecute/protocol/pull/135):
standalone Safe sends, published Merkle trees, signed bootstrap, leaf relay and direct delivery.
See [Safe-signed dispatch](#safe-signed-dispatch-protocol-pr-135) for the pinned revision and workflow.

## Install

```bash
npm install @crossecute/sdk @crossecute/protocol viem @openzeppelin/contracts@5.4.0 @openzeppelin/contracts-upgradeable@5.4.0
```

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
[`script/Example.s.sol`](script/Example.s.sol) is a complete script.

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
producer_setup  = "npm ci"

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

`npm run test:attest` runs Forge Attest v1.4.0's own reader and hash derivation over the
typed data the tests write, and checks the hash matches the SDK's.

## TypeScript

```ts
import { parsePlan, checkPlan, parseSafeTxTypedData, checkSafeTx, safeTxHashes, encodeEvm, encodeCalls, chainKey } from "@crossecute/sdk";
```

`checkPlan` re-derives each home call from its batch and throws if the calldata differs.
`checkSafeTx` throws unless the typed data is the one Safe transaction that carries the plan:
the owner Safe's domain on the home chain, no gas refund, and the plan's call directly or all
of its calls through a known MultiSendCallOnly.

```bash
npx crossecute check out/plan.json out/safe-tx.json
```

prints the batches, then the domain hash, message hash and `safeTxHash` a signer's device
shows. Its only runtime dependency is `@crossecute/protocol`; viem is a peer dependency
(`^2.57.18`), so a frontend keeps the single copy it already has.

## Development

```bash
npm install
npm test             # forge test, then vitest
npm run typecheck
npm run test:attest  # needs network access, jq and cast
```

`test/Vectors.t.sol` writes `vectors/` from the protocol's own Solidity encoders and the
SDK's MultiSendCallOnly table, and the TypeScript tests check their copies against it. The
TypeScript tests also read files the Foundry tests write under `out/`, so run `forge test`
first.

## Safe-signed dispatch (protocol PR #135)

The signed API targets protocol revision
[`5d7be13`](https://github.com/crossecute/protocol/commit/5d7be13e3afccb88c8a1b8a298bc56709706f76c).
It includes `SafeTxEvidence { signedSafeTx, nestedApprovals }`, `SignedSafeTx`,
`NestedSafeApproval`, authority records, execution/bootstrap leaves, and the current
transmitter, receiver (including nonce/authority views), transceiver, guard, and
`SafeBatchExecutor` ABIs. The published protocol 0.1.0
package predates these interfaces: the SDK includes a small MIT compatibility snapshot
under `contracts/vendor/protocol135`, with original-source checksums and a refresh script.
The existing plain planner and `crossecute check` still handle plain plans only.

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
signatures. Quotes can collect additional live approvals; use the returned bootstrap body
and deployed contract state as the authority for source transport.

A complete valid bundle can execute directly at the receiver **before the source transaction
executes**. Replacing/canceling the source transaction does not revoke it. Source checks use
live Safe owners, but receivers retain the creation authority; rotation is outside #135.

Signed sends must be individual Safe **CALL** transactions with zero `safeTxGas` and
`gasPrice`. Each has its own Safe nonce; do not use the plain planner's MultiSend transaction.
`safeBatchData([{ envelope, signatures }, ...])` encodes atomic source submission through
`SafeBatchExecutor`, checking source-chain consistency and consecutive nonces for each Safe.
The first nonce must match the Safe's live nonce at execution. The executor supplies no ETH;
fund the Safe/transmitter separately, or include the required transmitter top-up in the
Safe transaction's signed `value` before collecting signatures. Changing it requires new signatures.

### Published trees, bootstrap, relay and retry

```ts
import {
  encodeBootstrapLeaf, encodeExecutionLeaf, dispatchTree, publishLeavesData,
  signedBootstrapData, registerRootData, relayLeafData, submitLeafData,
} from "@crossecute/sdk";

const published = [encodeBootstrapLeaf(bootstrapLeaf), ...executionLeaves.map(encodeExecutionLeaf)];
const tree = dispatchTree(published);
const publishCalldata = publishLeavesData(published); // anyone calls the owner's guard
const bootstrapCalldata = signedBootstrapData(tree.root, bootstrapLeaf, tree.proofs[0], bootstrapAttributes);
const registrationCalldata = registerRootData(tree.root); // nonpayable; sign a separate Safe CALL
// Build/sign separate envelopes for bootstrap and registerRoot as above.
const relayCalldata = relayLeafData(registrationEvidence, executionLeaves[0], tree.proofs[1]);
const directCalldata = submitLeafData(registrationEvidence, executionLeaves[0], tree.proofs[1]);
```

Publication encodes a leaf's **fields**, not an offset-prefixed ABI tuple. Hashes are double
keccak; siblings are sorted, leaves stay in publication order, and odd last nodes move up
unchanged. `dispatchTree` returns proofs by original index; `verifyDispatchProof` checks them.
`executionId` excludes attributes while `executionLeafHash` includes them. Execution nonces
are local to each receiver; bootstrap has no local nonce. Windows are inclusive destination
block times: `validAfter <= timestamp <= deadline` (zero deadline is not unlimited).

`registerRoot` requires prior guard publication on the source. A source relay additionally
requires the root registered on that transmitter, unused leaf state, live quorum and a valid
route. Direct receiver submission verifies the signed registration/proof independently of
source registration or publication. It shares replay state with provider delivery.

Quote relay fees with `signedTransmitterAbi.quoteRelay` using the **funding relayer's account**,
then pay from that same account when calling `relayLeaf`; recipient-sensitive provider quotes
must match the sender. Excess and synchronous refunds return to the relayer; the transmitter's
prefunded balance is preserved. `quoteSignedBootstrap(evidence)` returns `(fee, body)`;
`retryBootstrap(body)` retries the exact pending body after failed source transport. Top-ups
for direct submissions remain at the receiver, including authenticated duplicates.

`encodeMerkleWire` and `encodeSignedBootstrap` build the exact transport encodings, including
nested approvals and creation records. `validateAuthorityRecords` checks canonical first-visit
DFS order, thresholds, kinds, cycles and reachability; `authorityGraphHash` hashes those records.
`signedConduitSalt` computes the signed salt commitment only. Obtain receiver addresses from
the deployed transceiver with `conduitTransceiverAbi.predictReceiver(chainKey, owner, salt, graph)`,
never local compiler initcode. `transceiverExtensionAbi` exposes `signedAuthority` and
`predictConduit`; `transceiverBaseAbi` includes conduit creation and signed bootstrap entry points.

There is no signed zkSync/Tron or LayerZero OFT path here. Provider payload sizing and gas must
include signatures, nested verification, proof and receiver work. The inherited 200k payload /
1m bootstrap defaults do not cover general signed delivery. These encoders do not certify a
live provider cap, fee, simulation result, signature quorum or destination state.

### Foundry signed builders

`SignedDispatch` supplies the same field encodings, Merkle root, standalone/bootstrap/root
calldata, wire bodies, relay and direct-submission calldata. Import `ExecutionLeaf`,
`BootstrapLeaf`, `SafeTxEvidence`, and `NestedSafeApproval` from
`@crossecute/sdk/vendor/protocol135/SignedDispatchTypes.sol`; `SafeTx` in `Types.sol` re-exports
the shared guard type. Build individual signed transactions with
`SignedDispatch.transaction(transmitter, nonce, data, value)`, hash with `SafeTxHash`, and
write Forge Attest input with `PlanJson.safeTxTypedData(homeChainId, ownerSafe, tx)`.
Simulate receiver calls and full provider entry points against pinned forks separately;
`CrossecuteScript._plan` is the plain-mode planner.

`test/SignedDispatch.t.sol` writes committed Solidity reference vectors for hashes, nested
wire encodings, calldata and atomic batches. TypeScript verifies parity against those vectors,
plus odd tree sizes, tampering, replay identities, authority graphs and source nonce order.
