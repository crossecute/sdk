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

This release covers plain mode: `sendMessage` and `bootstrap` from an owner Safe or EOA.
Safe-signed dispatch (standalone signed sends, Merkle roots, leaves and relay bundles) follows
once [crossecute/protocol#117](https://github.com/crossecute/protocol/pull/117) and
[crossecute/protocol#135](https://github.com/crossecute/protocol/pull/135) merge.

## Install

```bash
npm install @crossecute/sdk @crossecute/protocol @openzeppelin/contracts@5.4.0 @openzeppelin/contracts-upgradeable@5.4.0
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
shows. The only runtime dependency besides `@crossecute/protocol` is viem.

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
