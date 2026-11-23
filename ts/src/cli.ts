#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { createPublicClient, formatEther, http } from "viem";
import { AuthoritySource, planAuthorityCatchUp } from "./authority.js";
import { scaffoldAuthorityRelay } from "./authorityAttest.js";
import { parseDeliveryBundle, serializeDeliveryBundle } from "./bundle.js";
import { address, array, bytesHex, object, uint } from "./json.js";
import { requirePlan, parsePlan } from "./plan.js";
import { SafeQueue, type SafeQueueSigner } from "./safeQueue.js";
import { requireSafeTx, parseSafeTxTypedData, safeTxHashes, serializeSafeTxFields } from "./safeTx.js";

const usage = `usage: crossecute check <plan.json> [safe-tx.json]
       crossecute signed-propose <unsigned-bundle.json> <owner>
       crossecute signed-confirm <unsigned-bundle.json> <owner>
       crossecute signed-export <unsigned-bundle.json> <owner> [<owner> ...]
       crossecute authority-relay <relay-config.json> <new-output-directory>

check verifies a plain-mode plan and prints the Safe transaction hashes.
signed-propose and signed-confirm prompt for acknowledgment and sign with a Ledger via cast.
signed-export prints the bundle with confirmations for the specified destination quorum.
authority-relay scaffolds a Forge Attest Safe proposal for the receiver's next authority update.

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
  requirePlan(plan);
  console.log(
    `plan for Safe ${plan.owner} on chain ${plan.homeChainId}: ${plan.calls.length} call(s), ` +
      `fee ${formatEther(plan.fee)}, top-up ${formatEther(plan.calls[0].value)}`,
  );
  for (const b of plan.batches) {
    console.log(`  chain ${b.chainId}: ${b.bootstrap ? "bootstrap" : "message"} with ${b.calls.length} call(s) to ${b.receiver}`);
  }
  if (!safeTxPath) return;

  const envelope = parseSafeTxTypedData(readFileSync(safeTxPath, "utf8"));
  requireSafeTx(plan, envelope);
  const { domainHash, messageHash, safeTxHash } = safeTxHashes(envelope);
  console.log(`Safe transaction at nonce ${envelope.tx.nonce}${envelope.tx.operation === 1 ? " through MultiSendCallOnly" : ""}`);
  console.log(`  domain hash:  ${domainHash}`);
  console.log(`  message hash: ${messageHash}`);
  console.log(`  safeTxHash:   ${safeTxHash}`);
}

async function authorityRelay(configPath: string, directory: string): Promise<void> {
  const config = object(JSON.parse(readFileSync(configPath, "utf8")), [
    "sourceRpcEnv", "destinationRpcEnv", "sourceBlock", "destinationBlock", "guardFromBlock", "guard",
    "safe", "nonce", "transmitter", "receiver", "attributes", "producerRepo", "safeNetwork",
  ], "relay config");
  const { sourceRpcEnv, destinationRpcEnv, producerRepo, safeNetwork } = config;
  if (typeof sourceRpcEnv !== "string" || typeof destinationRpcEnv !== "string" ||
      typeof producerRepo !== "string" || typeof safeNetwork !== "string") {
    throw new Error("expected RPC environment names, producerRepo, and safeNetwork as strings");
  }
  function client(rpcEnv: string) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(rpcEnv)) throw new Error("invalid RPC environment variable name");
    const url = process.env[rpcEnv];
    if (!url) throw new Error(`${rpcEnv} is required`);
    return createPublicClient({ transport: http(url) });
  }

  const sourceRpc = client(sourceRpcEnv), receiverRpc = client(destinationRpcEnv);
  const [sourceId, destinationId] = await Promise.all([sourceRpc.getChainId(), receiverRpc.getChainId()]);
  const source = new AuthoritySource(
    sourceRpc, BigInt(sourceId), address(config.guard, "guard"),
    uint(config.sourceBlock, "sourceBlock"), uint(config.guardFromBlock, "guardFromBlock"),
  );
  const plan = await planAuthorityCatchUp({
    source, sourceRpc, receiverRpc, destinationChainId: BigInt(destinationId),
    destinationBlock: uint(config.destinationBlock, "destinationBlock"),
    safe: address(config.safe, "safe"), nonce: uint(config.nonce, "nonce"),
    transmitter: address(config.transmitter, "transmitter"), receiver: address(config.receiver, "receiver"),
    attributes: array(config.attributes, "attributes").map((value, i) => bytesHex(value, `attributes[${i}]`)),
  });
  if (plan.status === "current") {
    console.log(`Receiver is current at ${plan.destination.updateHead}.`);
    return;
  }
  const artifact = scaffoldAuthorityRelay(plan, { sourceRpcEnv, destinationRpcEnv, producerRepo, safeNetwork });
  await mkdir(directory);
  try {
    await mkdir(join(directory, "script"));
    await writeFile(join(directory, artifact.scriptPath), artifact.source, { flag: "wx" });
    await writeFile(join(directory, "attest.toml"), artifact.claim, { flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  console.log(`Prepared the next of ${plan.updates.length} authority updates.`);
  console.log(`Receiver head after delivery: ${plan.expected.updateHead}`);
  console.log(`Safe transaction hash: ${artifact.safeTxHash}`);
}

async function main([command, path, ...args]: string[]): Promise<void> {
  if (!path) throw new Error(usage);
  if (command === "authority-relay" && args.length === 1) return authorityRelay(path, args[0]);
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
