import type { Hex } from "viem";
import {
  type ExecutionLeaf, dispatchLeafHash, dispatchTreeFromHashes, encodeExecutionLeaf, executionId, publishLeavesCalldata,
} from "./signed.js";
import { array, bytesHex, object, uint, word } from "./json.js";

/** Version of the package layout and of the leaf, root and proof rules it records. */
export const MERKLE_PACKAGE_VERSION = 1;

/** The receiver's `nextNonce` when the plan was built. */
export type ReceiverNonce = { destination: Hex; nextNonce: bigint };
export type MerkleEntry = { leaf: ExecutionLeaf; hash: Hex; proof: readonly Hex[] };
export type MerklePackage = {
  version: typeof MERKLE_PACKAGE_VERSION;
  root: Hex;
  receiverNonces: readonly ReceiverNonce[];
  /** Publication order; the tree is defined by this order. */
  leaves: readonly MerkleEntry[];
};

const UINT256 = 2n ** 256n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Rejects plans the receiver would refuse or that waste a root: duplicate leaves, two different
 * batches at one receiver nonce (R11), a nonce below the observed `nextNonce`, and receiver nonces
 * that are missing, repeated or unused. The same batch at one nonce with different attributes is
 * allowed, since the receiver records it by execution ID.
 */
export function requireMerklePlan(leaves: readonly ExecutionLeaf[], receiverNonces: readonly ReceiverNonce[]): void {
  planHashes(leaves, receiverNonces);
}

/** Validates the plan and returns each leaf's hash, so a caller encodes and hashes every leaf once. */
function planHashes(leaves: readonly ExecutionLeaf[], receiverNonces: readonly ReceiverNonce[]): Hex[] {
  if (!leaves.length) throw new Error("no leaves");
  const observed = new Map<string, bigint>();
  for (const { destination, nextNonce } of receiverNonces) {
    const key = destination.toLowerCase();
    if (observed.has(key)) throw new Error("duplicate receiver nonce");
    if (nextNonce < 0n || nextNonce >= UINT256) throw new Error("invalid receiver nonce");
    observed.set(key, nextNonce);
  }
  const seen = new Set<string>(), batches = new Map<string, Hex>(), served = new Set<string>();
  const hashes = leaves.map((leaf) => {
    const hash = dispatchLeafHash(encodeExecutionLeaf(leaf));
    if (seen.has(hash)) throw new Error("duplicate leaf");
    seen.add(hash);
    const key = leaf.destination.toLowerCase(), next = observed.get(key);
    if (next === undefined) throw new Error("missing receiver nonce");
    served.add(key);
    if (leaf.nonce < next) throw new Error("stale nonce");
    const slot = `${key}:${leaf.nonce}`, id = executionId(leaf), prior = batches.get(slot);
    if (prior !== undefined && prior !== id) throw new Error("conflicting nonce");
    batches.set(slot, id);
    return hash;
  });
  for (const key of observed.keys()) if (!served.has(key)) throw new Error("receiver nonce without a leaf");
  return hashes;
}

function assemble(leaves: readonly ExecutionLeaf[], receiverNonces: readonly ReceiverNonce[]): MerklePackage {
  const tree = dispatchTreeFromHashes(planHashes(leaves, receiverNonces));
  return {
    version: MERKLE_PACKAGE_VERSION,
    root: tree.root,
    receiverNonces: receiverNonces.map(({ destination, nextNonce }) => ({ destination, nextNonce })),
    leaves: leaves.map((leaf, i) => ({ leaf, hash: tree.hashes[i], proof: tree.proofs[i] })),
  };
}

/**
 * Builds the root, leaf hashes and proofs the guard's `publishLeaves` records for `leaves`, in order.
 * Hex fields come back lowercase, as `parseMerklePackage` reads them.
 */
export function buildMerklePackage(leaves: readonly ExecutionLeaf[], receiverNonces: readonly ReceiverNonce[]): MerklePackage {
  return merklePackageFromJsonObject(merklePackageToJsonObject(assemble(leaves, receiverNonces)));
}

/** Rebuilds the package from its leaves and throws unless every recorded root, hash and proof matches. */
export function requireMerklePackage(pkg: MerklePackage): void {
  if (pkg.version !== MERKLE_PACKAGE_VERSION) throw new Error(`unsupported Merkle package version ${pkg.version}`);
  const rebuilt = assemble(pkg.leaves.map(({ leaf }) => leaf), pkg.receiverNonces);
  if (!same(pkg.root, rebuilt.root)) throw new Error("root mismatch");
  rebuilt.leaves.forEach((entry, i) => {
    const recorded = pkg.leaves[i];
    if (!same(recorded.hash, entry.hash)) throw new Error(`leaf hash mismatch at ${i}`);
    if (recorded.proof.length !== entry.proof.length || recorded.proof.some((p, j) => !same(p, entry.proof[j]))) {
      throw new Error(`proof mismatch at ${i}`);
    }
  });
}

/** Calldata for the guard's permissionless `publishLeaves`, carrying the ordered encoded leaves. */
export function publishMerklePackageCalldata(pkg: MerklePackage): Hex {
  return publishLeavesCalldata(pkg.leaves.map(({ leaf }) => encodeExecutionLeaf(leaf)));
}

type FieldType = "bytes" | "uint" | "bytes[]";
/** One table drives the JSON writer, the strict reader and the exact key set. */
const LEAF_FIELDS: readonly (readonly [keyof ExecutionLeaf & string, FieldType])[] = [
  ["destination", "bytes"], ["nonce", "uint"], ["validAfter", "uint"], ["deadline", "uint"], ["calls", "bytes"], ["attributes", "bytes[]"],
];

function fieldFromJSON(v: unknown, type: FieldType, at: string): unknown {
  if (type === "uint") return uint(v, at);
  if (type === "bytes") return bytesHex(v, at);
  return array(v, at).map((a, i) => bytesHex(a, `${at}[${i}]`));
}

export function merklePackageToJsonObject(pkg: MerklePackage): unknown {
  return {
    version: pkg.version,
    root: pkg.root,
    receiverNonces: pkg.receiverNonces.map((r) => ({ destination: r.destination, nextNonce: r.nextNonce.toString() })),
    leaves: pkg.leaves.map((e) => ({
      ...Object.fromEntries(LEAF_FIELDS.map(([name, type]) => {
        const v = e.leaf[name];
        return [name, type === "uint" ? (v as bigint).toString() : v];
      })),
      hash: e.hash,
      proof: e.proof,
    })),
  };
}

/** Reads the JSON layout strictly. The result is not checked against its tree; call `requireMerklePackage`. */
export function merklePackageFromJsonObject(raw: unknown, at = "merkle"): MerklePackage {
  const o = object(raw, ["version", "root", "receiverNonces", "leaves"], at);
  if (o.version !== MERKLE_PACKAGE_VERSION) throw new Error(`${at}.version: unsupported Merkle package version`);
  return {
    version: MERKLE_PACKAGE_VERSION,
    root: word(o.root, `${at}.root`),
    receiverNonces: array(o.receiverNonces, `${at}.receiverNonces`).map((r, i) => {
      const n = object(r, ["destination", "nextNonce"], `${at}.receiverNonces[${i}]`);
      return { destination: bytesHex(n.destination, "destination"), nextNonce: uint(n.nextNonce, "nextNonce") };
    }),
    leaves: array(o.leaves, `${at}.leaves`).map((r, i): MerkleEntry => {
      const p = `${at}.leaves[${i}]`, l = object(r, [...LEAF_FIELDS.map(([name]) => name), "hash", "proof"], p);
      return {
        leaf: Object.fromEntries(LEAF_FIELDS.map(([name, type]) => [name, fieldFromJSON(l[name], type, `${p}.${name}`)])) as unknown as ExecutionLeaf,
        hash: word(l.hash, `${p}.hash`),
        proof: array(l.proof, `${p}.proof`).map((w, j) => word(w, `${p}.proof[${j}]`)),
      };
    }),
  };
}

export function serializeMerklePackage(pkg: MerklePackage): string {
  requireMerklePackage(pkg);
  return JSON.stringify(merklePackageToJsonObject(pkg), null, 2) + "\n";
}

export function parseMerklePackage(json: string): MerklePackage {
  const pkg = merklePackageFromJsonObject(JSON.parse(json));
  requireMerklePackage(pkg);
  return pkg;
}
