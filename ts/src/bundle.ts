import { type Address, type Hex, decodeFunctionData } from "viem";
import { type SafeTxEnvelope, parseSafeTxFields, safeTxFieldNames, safeTxHashes, serializeSafeTxFields } from "./safeTx.js";
import {
  type NestedSafeApproval, type SafeTxEvidence, type SignedSafeTx, requireSignedDispatchRange, registerRootCalldata, relayLeafCalldata, sendMessageCalldataSigned,
  submitLeafCalldata, submitMessageCalldata,
} from "./signed.js";
import { signedTransmitterAbi } from "./signedAbi.js";
import { type MerklePackage, merklePackageFromJsonObject, merklePackageToJsonObject, requireMerklePackage } from "./merkle.js";
import { address, array, bytesHex, object, uint, word } from "./json.js";

/** Version of the exported delivery bundle layout. */
export const DELIVERY_BUNDLE_VERSION = 1;

/**
 * Everything an independent submitter needs to deliver one signed Safe transaction without the
 * proposer: the exact transaction and signature blob, the Safe and home chain it is signed under,
 * and nested approval evidence. `merkle` is set exactly when the transaction is a `registerRoot`.
 */
export type DeliveryBundle = {
  version: typeof DELIVERY_BUNDLE_VERSION;
  safe: Address;
  homeChainId: bigint;
  safeTxHash: Hex;
  evidence: SafeTxEvidence;
  merkle?: MerklePackage;
};

/** Builds and verifies a bundle. Addresses and hex fields come back in the form `parseDeliveryBundle` reads. */
export function buildDeliveryBundle(input: {
  envelope: SafeTxEnvelope;
  signatures: Hex;
  nestedApprovals?: readonly NestedSafeApproval[];
  merkle?: MerklePackage;
}): DeliveryBundle {
  const { envelope, signatures, nestedApprovals = [], merkle } = input;
  requireSignedDispatchRange(envelope.chainId, envelope.tx.nonce, envelope.tx.value);
  const bundle = deliveryBundleFromJsonObject(deliveryBundleToJsonObject({
    version: DELIVERY_BUNDLE_VERSION,
    safe: envelope.safe,
    homeChainId: envelope.chainId,
    safeTxHash: safeTxHashes(envelope).safeTxHash,
    evidence: { signedSafeTx: { safeTx: envelope.tx, signatures }, nestedApprovals },
    ...(merkle && { merkle }),
  }));
  requireDeliveryBundle(bundle);
  return bundle;
}

/**
 * Checks what needs no signer or RPC: the Safe transaction hash under the recorded domain, that the
 * calldata is exactly one `sendMessage` (standalone) or `registerRoot` of the package root (Merkle),
 * the package's tree, and unique nested approvals. It does not verify signatures, thresholds or
 * nested approval contents; the receiver does.
 */
export function requireDeliveryBundle(bundle: DeliveryBundle): void {
  if (bundle.version !== DELIVERY_BUNDLE_VERSION) throw new Error(`unsupported delivery bundle version ${bundle.version}`);
  const { safeTx } = bundle.evidence.signedSafeTx;
  requireSignedDispatchRange(bundle.homeChainId, safeTx.nonce, safeTx.value);
  const envelope: SafeTxEnvelope = { chainId: bundle.homeChainId, safe: bundle.safe, tx: safeTx };
  if (safeTxHashes(envelope).safeTxHash.toLowerCase() !== bundle.safeTxHash.toLowerCase()) throw new Error("safeTxHash mismatch");
  if (safeTx.operation !== 0) throw new Error("signed dispatch must be a CALL");

  const data = safeTx.data.toLowerCase();
  if (bundle.merkle) {
    requireMerklePackage(bundle.merkle);
    if (data !== registerRootCalldata(bundle.merkle.root)) throw new Error("transaction is not registerRoot of the package root");
  } else {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: signedTransmitterAbi, data: safeTx.data });
    } catch {
      throw new Error("transaction is not a signed sendMessage");
    }
    if (decoded.functionName !== "sendMessage") throw new Error("transaction is not a signed sendMessage");
    const [destination, calls, attributes] = decoded.args;
    if (data !== sendMessageCalldataSigned(destination, calls, attributes)) throw new Error("transaction is not a signed sendMessage");
  }

  const seen = new Set<string>();
  for (const { childSafe, messageHash } of bundle.evidence.nestedApprovals) {
    const key = `${childSafe.toLowerCase()}:${messageHash.toLowerCase()}`;
    if (seen.has(key)) throw new Error("duplicate nested approval");
    seen.add(key);
  }
}

function leafEntry(bundle: DeliveryBundle, index: number) {
  const entry = bundle.merkle?.leaves[index];
  if (!entry) throw new Error("no such Merkle leaf");
  return entry;
}

/** `relayLeaf` calldata for a transmitter on the source chain. */
export function relayLeafFromBundle(bundle: DeliveryBundle, index: number): Hex {
  const { leaf, proof } = leafEntry(bundle, index);
  return relayLeafCalldata(bundle.evidence, leaf, proof);
}

/** `submitLeaf` calldata for the destination receiver, with no provider involved. */
export function submitLeafFromBundle(bundle: DeliveryBundle, index: number): Hex {
  const { leaf, proof } = leafEntry(bundle, index);
  return submitLeafCalldata(bundle.evidence, leaf, proof);
}

/** `submitMessage` calldata for a standalone bundle. */
export function submitMessageFromBundle(bundle: DeliveryBundle): Hex {
  if (bundle.merkle) throw new Error("not a standalone bundle");
  return submitMessageCalldata(bundle.evidence);
}

const signedTxToJSON = ({ safeTx, signatures }: SignedSafeTx) => ({ safeTx: serializeSafeTxFields(safeTx), signatures });
const signedTxFromJSON = (raw: unknown, at: string): SignedSafeTx => {
  const o = object(raw, ["safeTx", "signatures"], at);
  return { safeTx: parseSafeTxFields(object(o.safeTx, safeTxFieldNames, `${at}.safeTx`)), signatures: bytesHex(o.signatures, `${at}.signatures`) };
};

export function deliveryBundleToJsonObject(bundle: DeliveryBundle): unknown {
  return {
    version: bundle.version,
    safe: bundle.safe,
    homeChainId: bundle.homeChainId.toString(),
    safeTxHash: bundle.safeTxHash,
    signedSafeTx: signedTxToJSON(bundle.evidence.signedSafeTx),
    nestedApprovals: bundle.evidence.nestedApprovals.map((n) => ({ childSafe: n.childSafe, messageHash: n.messageHash, approval: signedTxToJSON(n.approval) })),
    merkle: bundle.merkle ? merklePackageToJsonObject(bundle.merkle) : null,
  };
}

/** Reads the JSON layout strictly. The result is not verified; call `requireDeliveryBundle`. */
export function deliveryBundleFromJsonObject(raw: unknown): DeliveryBundle {
  const o = object(raw, ["version", "safe", "homeChainId", "safeTxHash", "signedSafeTx", "nestedApprovals", "merkle"], "bundle");
  if (o.version !== DELIVERY_BUNDLE_VERSION) throw new Error("bundle.version: unsupported delivery bundle version");
  return {
    version: DELIVERY_BUNDLE_VERSION,
    safe: address(o.safe, "bundle.safe"),
    homeChainId: uint(o.homeChainId, "bundle.homeChainId"),
    safeTxHash: word(o.safeTxHash, "bundle.safeTxHash"),
    evidence: {
      signedSafeTx: signedTxFromJSON(o.signedSafeTx, "bundle.signedSafeTx"),
      nestedApprovals: array(o.nestedApprovals, "bundle.nestedApprovals").map((r, i): NestedSafeApproval => {
        const n = object(r, ["childSafe", "messageHash", "approval"], `bundle.nestedApprovals[${i}]`);
        return { childSafe: address(n.childSafe, "childSafe"), messageHash: word(n.messageHash, "messageHash"), approval: signedTxFromJSON(n.approval, `bundle.nestedApprovals[${i}].approval`) };
      }),
    },
    ...(o.merkle !== null && { merkle: merklePackageFromJsonObject(o.merkle) }),
  };
}

export function serializeDeliveryBundle(bundle: DeliveryBundle): string {
  requireDeliveryBundle(bundle);
  return JSON.stringify(deliveryBundleToJsonObject(bundle), null, 2) + "\n";
}

/** Strictly parses the JSON layout, then runs `requireDeliveryBundle`. */
export function parseDeliveryBundle(json: string): DeliveryBundle {
  const bundle = deliveryBundleFromJsonObject(JSON.parse(json));
  requireDeliveryBundle(bundle);
  return bundle;
}
