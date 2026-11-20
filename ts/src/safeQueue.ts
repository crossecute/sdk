import { type Address, type Hex, concatHex, hashMessage, recoverAddress, toHex, zeroAddress } from "viem";
import { type DeliveryBundle, buildDeliveryBundle, parseDeliveryBundle, serializeDeliveryBundle } from "./bundle.js";
import { address, array, bytesHex, uint, word } from "./json.js";
import {
  parseSafeTxFields, safeTxFieldNames, safeTxHashes, safeTxTypes, serializeSafeTxFields,
} from "./safeTx.js";

export const signedDispatchNotice =
  "Anyone with a bundle that meets the destination quorum can execute it before the source Safe transaction executes. " +
  "Canceling or replacing the source transaction at the same Safe nonce does not revoke that authorization.";

type SignedDispatchTypedData = {
  domain: { chainId: bigint; verifyingContract: Address };
  types: typeof safeTxTypes;
  primaryType: "SafeTx";
  message: DeliveryBundle["evidence"]["signedSafeTx"]["safeTx"];
};

export type SafeQueueSigner = {
  address: Address;
  acknowledge: (notice: string, draft: DeliveryBundle) => boolean | Promise<boolean>;
  signTypedData: (data: SignedDispatchTypedData) => Promise<Hex>;
};

function unsignedDraft(input: DeliveryBundle): DeliveryBundle {
  const draft = parseDeliveryBundle(serializeDeliveryBundle(input));
  if (draft.evidence.signedSafeTx.signatures !== "0x") throw new Error("expected an unsigned delivery bundle");
  return draft;
}

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Safe Queue response");
  }
  return value as Record<string, unknown>;
}

function matchingTransaction(value: unknown, draft: DeliveryBundle): Record<string, unknown> {
  const record = fields(value);
  const message = Object.fromEntries(safeTxFieldNames.map((name) => [name, record[name]]));
  for (const key of ["to", "gasToken", "refundReceiver"]) {
    if (message[key] === null) message[key] = zeroAddress;
  }
  if (typeof message.operation === "number") message.operation = String(message.operation);
  const envelope = {
    chainId: uint(record.chainId, "queue.chainId"),
    safe: address(record.safe, "queue.safe"),
    tx: parseSafeTxFields(message),
  };
  if (word(record.safeTxHash, "queue.safeTxHash") !== draft.safeTxHash ||
      safeTxHashes(envelope).safeTxHash !== draft.safeTxHash) {
    throw new Error("Safe Queue transaction does not match the unsigned bundle");
  }
  return record;
}

async function checkedSignature(value: unknown, digest: Hex, owner: Address): Promise<Hex> {
  const signature = bytesHex(value, "signature");
  const v = Number.parseInt(signature.slice(-2), 16);
  if (signature.length !== 132 || ![27, 28, 31, 32].includes(v)) {
    throw new Error(`expected a portable EOA signature from ${owner}`);
  }
  // Safe encodes personal_sign by adding four to the recovery byte.
  const recovered = v > 30
    ? await recoverAddress({
      hash: hashMessage({ raw: digest }), signature: concatHex([signature.slice(0, -2) as Hex, toHex(v - 4)]),
    })
    : await recoverAddress({ hash: digest, signature });
  if (recovered !== owner) throw new Error(`signature does not match ${owner} and the Safe transaction`);
  return signature;
}

async function sign(draft: DeliveryBundle, signer: SafeQueueSigner, owner: Address): Promise<Hex> {
  if (await signer.acknowledge(signedDispatchNotice, structuredClone(draft)) !== true) {
    throw new Error("signer acknowledgment is required");
  }
  const signature = await signer.signTypedData({
    domain: { chainId: draft.homeChainId, verifyingContract: draft.safe },
    types: safeTxTypes,
    primaryType: "SafeTx",
    message: { ...draft.evidence.signedSafeTx.safeTx },
  });
  return checkedSignature(signature, draft.safeTxHash, owner);
}

function confirmations(value: unknown): Map<Address, unknown> {
  const out = new Map<Address, unknown>();
  for (const item of array(value, "queue.confirmations")) {
    const row = fields(item);
    const owner = address(row.owner, "confirmation.owner");
    if (out.has(owner)) throw new Error(`duplicate confirmation for ${owner}`);
    out.set(owner, row.signature);
  }
  return out;
}

/** Proposes and confirms off-chain through Safe Queue. Each signing call requires its own acknowledgment. */
export class SafeQueue {
  private readonly url: URL;
  private readonly apiKey?: string;

  constructor({ apiKey, baseUrl = "https://api.safe.global/queue" }: { apiKey?: string; baseUrl?: string } = {}) {
    this.url = new URL(`${baseUrl.replace(/\/$/, "")}/api/v1/multisig-transactions`);
    this.apiKey = apiKey;
  }

  private async request(path: string, body?: object): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(body && { "content-type": "application/json" }),
        ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }),
      },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Safe Queue ${body ? "POST" : "GET"} returned HTTP ${response.status}`);
    return response.json();
  }

  private async getTransaction(draft: DeliveryBundle): Promise<Record<string, unknown>> {
    return matchingTransaction(await this.request(`/${draft.safeTxHash}`), draft);
  }

  async propose(input: DeliveryBundle, signer: SafeQueueSigner): Promise<Hex> {
    const draft = unsignedDraft(input);
    const owner = address(signer.address, "signer.address");
    const signature = await sign(draft, signer, owner);
    const result = matchingTransaction(await this.request("", {
      ...serializeSafeTxFields(draft.evidence.signedSafeTx.safeTx),
      operation: draft.evidence.signedSafeTx.safeTx.operation,
      safe: draft.safe,
      chainId: draft.homeChainId.toString(),
      signatures: [signature],
      originName: "Crossecute",
    }), draft);
    if (bytesHex(confirmations(result.confirmations).get(owner), "proposer confirmation") !== signature) {
      throw new Error("Safe Queue did not record the proposal signature as an owner confirmation");
    }
    return draft.safeTxHash;
  }

  async confirm(input: DeliveryBundle, signer: SafeQueueSigner): Promise<Hex> {
    const draft = unsignedDraft(input);
    const owner = address(signer.address, "signer.address");
    const transaction = await this.getTransaction(draft);
    if (transaction.txHash !== null) throw new Error("Safe Queue transaction has already executed");
    if (confirmations(transaction.confirmations ?? []).has(owner)) throw new Error(`${owner} has already confirmed`);
    const signature = await sign(draft, signer, owner);
    const result = confirmations(await this.request(`/${draft.safeTxHash}/signatures`, { signatures: [signature] }));
    if (bytesHex(result.get(owner), "owner confirmation") !== signature) {
      throw new Error("Safe Queue returned a different confirmation signature");
    }
    return draft.safeTxHash;
  }

  /** Exports the selected EOA confirmations. Choose owners forming a quorum on the target receiver. */
  async exportBundle(input: DeliveryBundle, owners: readonly Address[]): Promise<DeliveryBundle> {
    const draft = unsignedDraft(input);
    const sorted = owners.map((owner) => address(owner, "owner"))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (!sorted.length || new Set(sorted).size !== sorted.length) {
      throw new Error("provide a non-empty set of distinct destination quorum owners");
    }
    const transaction = await this.getTransaction(draft);
    const available = confirmations(transaction.confirmations ?? []);
    const signatures = await Promise.all(sorted.map((owner) => {
      if (!available.has(owner)) throw new Error(`missing confirmation for ${owner}`);
      return checkedSignature(available.get(owner), draft.safeTxHash, owner);
    }));
    return buildDeliveryBundle({
      envelope: { safe: draft.safe, chainId: draft.homeChainId, tx: draft.evidence.signedSafeTx.safeTx },
      signatures: concatHex(signatures),
      merkle: draft.merkle,
      nestedApprovals: draft.evidence.nestedApprovals,
    });
  }
}
