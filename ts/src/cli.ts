#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { formatEther } from "viem";
import { checkPlan, parsePlan } from "./plan.js";
import { checkSafeTx, parseSafeTxTypedData, safeTxHashes } from "./safeTx.js";

const usage = `usage: crossecute check <plan.json> [safe-tx.json]

Checks the plan's calls against its batches and, given the Safe transaction's typed data,
that it carries exactly those calls. Prints the hashes a signer's device shows.

The SDK holds no keys and sends nothing. Sign and propose with Forge Attest
(./attest.sh --attest -- --ledger) or cast wallet sign --data --from-file <safe-tx.json>.`;

function main([command, planPath, safeTxPath]: string[]): void {
  if (command !== "check" || !planPath) throw new Error(usage);
  const plan = parsePlan(readFileSync(planPath, "utf8"));
  checkPlan(plan);
  console.log(
    `plan for Safe ${plan.owner} on chain ${plan.homeChainId}: ${plan.calls.length} call(s), ` +
      `fee ${formatEther(plan.fee)}, top-up ${formatEther(plan.calls[0].value)}`,
  );
  for (const b of plan.batches) {
    console.log(`  chain ${b.chainId}: ${b.bootstrap ? "bootstrap" : "message"} with ${b.calls.length} call(s) to ${b.receiver}`);
  }
  if (!safeTxPath) return;

  const envelope = parseSafeTxTypedData(readFileSync(safeTxPath, "utf8"));
  checkSafeTx(plan, envelope);
  const { domainHash, messageHash, safeTxHash } = safeTxHashes(envelope);
  console.log(`Safe transaction at nonce ${envelope.tx.nonce}${envelope.tx.operation === 1 ? " through MultiSendCallOnly" : ""}`);
  console.log(`  domain hash:  ${domainHash}`);
  console.log(`  message hash: ${messageHash}`);
  console.log(`  safeTxHash:   ${safeTxHash}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
