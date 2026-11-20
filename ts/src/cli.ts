#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { formatEther } from "viem";
import { parseDeliveryBundle, serializeDeliveryBundle } from "./bundle.js";
import { address, bytesHex } from "./json.js";
import { checkPlan, parsePlan } from "./plan.js";
import { SafeQueue, type SafeQueueSigner } from "./safeQueue.js";
import { checkSafeTx, parseSafeTxTypedData, safeTxHashes, serializeSafeTxFields } from "./safeTx.js";

const usage = `usage: crossecute check <plan.json> [safe-tx.json]
       crossecute signed-propose <unsigned-bundle.json> <owner>
       crossecute signed-confirm <unsigned-bundle.json> <owner>
       crossecute signed-export <unsigned-bundle.json> <owner> [<owner> ...]

check verifies a plain-mode plan and prints the Safe transaction hashes.
signed-propose and signed-confirm prompt for acknowledgment and sign with a Ledger via cast.
signed-export prints the bundle with confirmations for the specified destination quorum.

Set SAFE_API_KEY to authenticate requests to Safe Queue.`;

const run = promisify(execFile);

const signWithLedger: SafeQueueSigner["signTypedData"] = async ({ domain, message, ...rest }) => {
  const dir = await mkdtemp(join(tmpdir(), "crossecute-sign-"));
  const path = join(dir, "safe-tx.json");
  try {
    await writeFile(path, JSON.stringify({ ...rest, domain: { ...domain, chainId: domain.chainId.toString() },
      message: serializeSafeTxFields(message) }));
    const { stdout } = await run("cast", ["wallet", "sign", "--data", "--from-file", path, "--ledger"]);
    return bytesHex(stdout.trim(), "cast signature");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

async function signedQueue(command: string, draftPath: string, owners: string[]): Promise<void> {
  const draft = parseDeliveryBundle(readFileSync(draftPath, "utf8"));
  const queue = new SafeQueue({ apiKey: process.env.SAFE_API_KEY });
  if (command === "signed-export") {
    process.stdout.write(serializeDeliveryBundle(await queue.exportBundle(draft, owners.map((owner) => address(owner, "owner")))));
    return;
  }
  if (owners.length !== 1) throw new Error(usage);
  const signer: SafeQueueSigner = {
    address: address(owners[0], "owner"),
    async acknowledge(notice, verifiedDraft) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("signing requires an interactive terminal");
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        console.error(`Safe ${verifiedDraft.safe} on chain ${verifiedDraft.homeChainId}`);
        console.error(`Safe transaction ${verifiedDraft.safeTxHash}`);
        console.error(`Review the destination calls in ${draftPath} before signing.\n\n${notice}\n`);
        return await prompt.question("Type I AGREE to continue with signing: ") === "I AGREE";
      } finally {
        prompt.close();
      }
    },
    signTypedData: signWithLedger,
  };
  const hash = command === "signed-propose" ? await queue.propose(draft, signer) : await queue.confirm(draft, signer);
  console.log(hash);
}

function check(planPath: string, safeTxPath?: string): void {
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

async function main([command, path, ...args]: string[]): Promise<void> {
  if (!path) throw new Error(usage);
  if (command === "check" && args.length <= 1) return check(path, args[0]);
  if (["signed-propose", "signed-confirm", "signed-export"].includes(command)) return signedQueue(command, path, args);
  throw new Error(usage);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
