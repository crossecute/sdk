# @crossecute/sdk

Foundry and TypeScript helpers for running calls on a Crossecute conduit's receivers. A
Foundry script simulates each batch as the receiver on a fork of its destination, turns the
batches into the owner's calls on the home chain, and writes or submits them. The TypeScript
side reads the same plan file, checks it, and proposes it to the owner Safe; a frontend can use
the same encoders.

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

The project supplies `forge-std` itself. The sources need solc 0.8.28 or later.

## Foundry

Extend `CrossecuteScript`. [`script/Example.s.sol`](script/Example.s.sol) is a complete script.

```solidity
_useHome(vm.rpcUrl("mainnet"), transmitter);
uint256 optimism = _useDestination(vm.rpcUrl("optimism"));

_add(optimism, calls, new bytes[](0)); // simulated as the receiver on the Optimism fork
Plan memory plan = _plan();            // the owner's calls, run once on the home fork as a check

_writeSafeBatch(plan, "out/batch.json"); // Safe Transaction Builder file
_writePlan(plan, "out/plan.json");       // for `crossecute propose` or a frontend
_proposeToSafe(plan, "out/plan.json");   // runs `crossecute propose` (needs ffi = true)
_broadcast(plan);                         // owner is an EOA and the script's signer
```

What it does and does not check:

- **The receiver.** Once bootstrapped, the receiver address comes from the transmitter's
  record. Before that, it comes from the home transceiver's `predictReceiver`. The SDK never
  derives it locally, because `Proxy`'s initcode hash depends on the compiler settings. A
  destination that reports its receiver back (zkSync, Tron) has no address until the report
  arrives, and `_add` reverts with `ReceiverNotPredictable`.
- **Simulation.** Each call runs from the receiver's address on the destination fork, in order,
  and later batches build on earlier ones. A call that reverts stops the script with
  `CallReverted(chainId, index, reason)`. If the receiver holds less than the batch's total
  value, `_add` reverts: a send cannot fund the receiver. Where the receiver is not deployed
  yet, a call back into it meets no code, so a callback the real receiver would refuse
  succeeds in simulation.
- **Gas.** With empty attributes a batch gets the provider's default delivery gas
  (`DeliveryGas`). The script logs a warning when the calls alone use more than that default.
  The default also pays the receiver's own overhead, so this check is a floor, not a guarantee.
- **Bootstrap or send.** The first batch to a destination with no receiver becomes its
  `bootstrap`; later batches become `sendMessage`.
- **Fees.** The transmitter pays fees from its own balance. `_plan` quotes every call in order
  and sets `calls[0].value` to top the balance up to the total plus `feeBufferBps` (10% by
  default). Anything left over stays in the transmitter for later sends.
- **The home calls.** `_plan` runs them as the owner on the home fork and then restores that
  fork's state.

## TypeScript

```ts
import { parsePlan, checkPlan, proposePlan, encodeEvm, encodeCalls, chainKey } from "@crossecute/sdk";
```

`checkPlan` re-derives each home call from its batch and throws if the calldata differs, so a
plan file edited after simulation cannot be proposed with other calldata. `proposePlan` and
the CLI run `checkPlan` before proposing.

```bash
npx crossecute check out/plan.json
CROSSECUTE_RPC_URL=... SAFE_PROPOSER_PRIVATE_KEY=... SAFE_API_KEY=... npx crossecute propose out/plan.json
```

A proposal takes the Transaction Service's next nonce, so it queues behind pending
transactions. Several calls go through MultiSendCallOnly; one call goes as a direct `CALL`.

## Development

```bash
npm install
npm test          # forge test, then vitest
npm run typecheck
```

`test/Vectors.t.sol` writes `vectors/encoding.json` from the protocol's own Solidity encoders,
and the TypeScript tests check their encoders against it. `ts/test/plan.test.ts` reads the plan
file `test/CrossecuteScript.t.sol` writes, so run `forge test` first.

`@crossecute/protocol` is installed from `.packages/` until it is published to the registry.
