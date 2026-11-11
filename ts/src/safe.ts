import ApiKitModule from "@safe-global/api-kit";
import ProtocolKitModule from "@safe-global/protocol-kit";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Plan, checkPlan } from "./plan.js";

// The kits ship ESM with CommonJS-style declarations, so TypeScript sees the default export
// under `.default` while Node's ESM loader returns it directly.
const SafeApiKit = ((ApiKitModule as any).default ?? ApiKitModule) as typeof ApiKitModule.default;
const Safe = ((ProtocolKitModule as any).default ?? ProtocolKitModule) as typeof ProtocolKitModule.default;

export type ProposeOptions = {
  rpcUrl: string;
  /** Key of a Safe owner or delegate that signs the proposal. */
  privateKey: Hex;
  /** Required by Safe's hosted Transaction Service. */
  apiKey?: string;
  txServiceUrl?: string;
};

/**
 * Proposes `plan` to its owner Safe at the Transaction Service's next nonce, so it queues
 * behind pending transactions. Several calls go through MultiSendCallOnly; one goes as a direct
 * CALL.
 */
export async function proposePlan(plan: Plan, options: ProposeOptions): Promise<{ safeTxHash: string; nonce: number }> {
  checkPlan(plan);
  const apiKit = new SafeApiKit({ chainId: plan.homeChainId, apiKey: options.apiKey, txServiceUrl: options.txServiceUrl });
  const protocolKit = await Safe.init({ provider: options.rpcUrl, signer: options.privateKey, safeAddress: plan.owner });
  const chainId = await protocolKit.getChainId();
  if (chainId !== plan.homeChainId) throw new Error(`RPC is chain ${chainId}, the plan is for ${plan.homeChainId}`);

  const nonce = Number(await apiKit.getNextNonce(plan.owner));
  const tx = await protocolKit.createTransaction({
    transactions: plan.calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data, operation: 0 })),
    onlyCalls: true,
    options: { nonce },
  });
  const safeTxHash = await protocolKit.getTransactionHash(tx);
  const signature = await protocolKit.signHash(safeTxHash);
  await apiKit.proposeTransaction({
    safeAddress: plan.owner,
    safeTransactionData: tx.data,
    safeTxHash,
    senderAddress: privateKeyToAccount(options.privateKey).address,
    senderSignature: signature.data,
    origin: "crossecute",
  });
  return { safeTxHash, nonce };
}
