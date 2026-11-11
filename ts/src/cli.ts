#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { formatEther, isHex } from "viem";
import { checkPlan, parsePlan } from "./plan.js";
import { proposePlan } from "./safe.js";

const usage = `usage:
  crossecute check <plan.json>     check a plan's calls against its batches
  crossecute propose <plan.json>   check, then propose it to the owner Safe

propose reads CROSSECUTE_RPC_URL (the home chain), SAFE_PROPOSER_PRIVATE_KEY, and SAFE_API_KEY
or SAFE_TX_SERVICE_URL.`;

async function main([command, path]: string[]): Promise<void> {
  if (!path || (command !== "check" && command !== "propose")) throw new Error(usage);
  const plan = parsePlan(readFileSync(path, "utf8"));
  checkPlan(plan);
  console.log(
    `plan for Safe ${plan.owner} on chain ${plan.homeChainId}: ${plan.calls.length} call(s), ` +
      `fee ${formatEther(plan.fee)}, top-up ${formatEther(plan.calls[0].value)}`,
  );
  for (const b of plan.batches) {
    console.log(`  chain ${b.chainId}: ${b.bootstrap ? "bootstrap" : "message"} with ${b.calls.length} call(s) to ${b.receiver}`);
  }
  if (command === "check") return;

  const rpcUrl = process.env.CROSSECUTE_RPC_URL;
  const privateKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
  if (!rpcUrl) throw new Error("CROSSECUTE_RPC_URL is not set");
  if (!privateKey || !isHex(privateKey)) throw new Error("SAFE_PROPOSER_PRIVATE_KEY is not set to a hex key");
  const { safeTxHash, nonce } = await proposePlan(plan, {
    rpcUrl,
    privateKey,
    apiKey: process.env.SAFE_API_KEY,
    txServiceUrl: process.env.SAFE_TX_SERVICE_URL,
  });
  console.log(`proposed at nonce ${nonce}: ${safeTxHash}`);
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
