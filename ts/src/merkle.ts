import type { Hex } from "viem";
import {
  type BootstrapLeaf, type ExecutionLeaf, dispatchLeafHash, dispatchTree, encodeBootstrapLeaf, encodeExecutionLeaf, executionId, publishLeavesData,
} from "./signed.js";
import { array, bytesHex, object, uint, word } from "./json.js";

/** Version of the package layout and of the leaf, root and proof rules it records. */
export const MERKLE_PACKAGE_VERSION = 1;

export type MerkleLeaf = { kind: "execution"; leaf: ExecutionLeaf } | { kind: "bootstrap"; leaf: BootstrapLeaf };
/** The receiver's `nextNonce` when the plan was built. */
export type ReceiverNonce = { destination: Hex; nextNonce: bigint };
export type MerkleEntry = MerkleLeaf & { hash: Hex; proof: readonly Hex[] };
export type MerklePackage = {
  version: typeof MERKLE_PACKAGE_VERSION;
  root: Hex;
  receiverNonces: readonly ReceiverNonce[];
  /** Publication order; the tree is defined by this order. */
  leaves: readonly MerkleEntry[];
};

const UINT256 = 2n ** 256n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function encodeMerkleLeaf(entry: MerkleLeaf): Hex {
  return entry.kind === "execution" ? encodeExecutionLeaf(entry.leaf) : encodeBootstrapLeaf(entry.leaf);
}

/**
 * Rejects plans the receiver would refuse or that waste a root: duplicate leaves, two different
 * batches at one receiver nonce (R11), a nonce below the observed `nextNonce`, and receiver nonces
 * that are missing, repeated or unused. The same batch at one nonce with different attributes is
 * allowed, since the receiver records it by execution ID.
 */
export function checkMerklePlan(leaves: readonly MerkleLeaf[], receiverNonces: readonly ReceiverNonce[]): void {
  if (!leaves.length) throw new Error("no leaves");
  const observed = new Map<string, bigint>();
  for (const { destination, nextNonce } of receiverNonces) {
    const key = destination.toLowerCase();
    if (observed.has(key)) throw new Error("duplicate receiver nonce");
    if (nextNonce < 0n || nextNonce >= UINT256) throw new Error("invalid receiver nonce");
    observed.set(key, nextNonce);
  }
  const hashes = new Set<string>(), batches = new Map<string, Hex>(), served = new Set<string>();
  for (const entry of leaves) {
    const hash = dispatchLeafHash(encodeMerkleLeaf(entry));
    if (hashes.has(hash)) throw new Error("duplicate leaf");
    hashes.add(hash);
    if (entry.kind !== "execution") continue;
    const { leaf } = entry, key = leaf.destination.toLowerCase(), next = observed.get(key);
    if (next === undefined) throw new Error("missing receiver nonce");
    served.add(key);
    if (leaf.nonce < next) throw new Error("stale nonce");
    const slot = `${key}:${leaf.nonce}`, id = executionId(leaf), prior = batches.get(slot);
    if (prior !== undefined && prior !== id) throw new Error("conflicting nonce");
    batches.set(slot, id);
  }
  for (const key of observed.keys()) if (!served.has(key)) throw new Error("receiver nonce without a leaf");
}

/** Builds the root, leaf hashes and proofs the guard's `publishLeaves` records for `leaves`, in order. */
export function buildMerklePackage(leaves: readonly MerkleLeaf[], receiverNonces: readonly ReceiverNonce[]): MerklePackage {
  checkMerklePlan(leaves, receiverNonces);
  const tree = dispatchTree(leaves.map(encodeMerkleLeaf));
  return {
    version: MERKLE_PACKAGE_VERSION,
    root: tree.root,
    receiverNonces: receiverNonces.map(({ destination, nextNonce }) => ({ destination, nextNonce })),
    leaves: leaves.map((entry, i) => ({ ...entry, hash: tree.hashes[i], proof: tree.proofs[i] }) as MerkleEntry),
  };
}

/** Rebuilds the package from its leaves and throws unless every recorded root, hash and proof matches. */
export function verifyMerklePackage(pkg: MerklePackage): void {
  if (pkg.version !== MERKLE_PACKAGE_VERSION) throw new Error(`unsupported Merkle package version ${pkg.version}`);
  const rebuilt = buildMerklePackage(pkg.leaves.map(({ kind, leaf }) => ({ kind, leaf }) as MerkleLeaf), pkg.receiverNonces);
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
export function merklePublishData(pkg: MerklePackage): Hex {
  return publishLeavesData(pkg.leaves.map(encodeMerkleLeaf));
}

const executionKeys = ["kind", "destination", "nonce", "validAfter", "deadline", "calls", "attributes", "hash", "proof"];
const bootstrapKeys = ["kind", "destination", "validAfter", "deadline", "setupCalls", "hash", "proof"];

export function merklePackageToJSON(pkg: MerklePackage): unknown {
  return {
    version: pkg.version,
    root: pkg.root,
    receiverNonces: pkg.receiverNonces.map((r) => ({ destination: r.destination, nextNonce: r.nextNonce.toString() })),
    leaves: pkg.leaves.map((e) => {
      const { hash, proof } = e;
      if (e.kind === "bootstrap") {
        const { destination, validAfter, deadline, setupCalls } = e.leaf;
        return { kind: e.kind, destination, validAfter: validAfter.toString(), deadline: deadline.toString(), setupCalls, hash, proof };
      }
      const { destination, nonce, validAfter, deadline, calls, attributes } = e.leaf;
      return {
        kind: e.kind, destination, nonce: nonce.toString(), validAfter: validAfter.toString(), deadline: deadline.toString(),
        calls, attributes, hash, proof,
      };
    }),
  };
}

/** Reads the JSON layout strictly. The result is not checked against its tree; call `verifyMerklePackage`. */
export function merklePackageFromJSON(raw: unknown, at = "merkle"): MerklePackage {
  const o = object(raw, ["version", "root", "receiverNonces", "leaves"], at);
  if (o.version !== MERKLE_PACKAGE_VERSION) throw new Error(`${at}.version: unsupported Merkle package version`);
  const leafWords = (v: unknown, p: string) => array(v, p).map((w, i) => word(w, `${p}[${i}]`));
  return {
    version: MERKLE_PACKAGE_VERSION,
    root: word(o.root, `${at}.root`),
    receiverNonces: array(o.receiverNonces, `${at}.receiverNonces`).map((r, i) => {
      const n = object(r, ["destination", "nextNonce"], `${at}.receiverNonces[${i}]`);
      return { destination: bytesHex(n.destination, "destination"), nextNonce: uint(n.nextNonce, "nextNonce") };
    }),
    leaves: array(o.leaves, `${at}.leaves`).map((r, i): MerkleEntry => {
      const p = `${at}.leaves[${i}]`, kind = (r as { kind?: unknown } | null)?.kind;
      if (kind === "bootstrap") {
        const l = object(r, bootstrapKeys, p);
        return {
          kind, hash: word(l.hash, `${p}.hash`), proof: leafWords(l.proof, `${p}.proof`),
          leaf: { destination: bytesHex(l.destination, "destination"), validAfter: uint(l.validAfter, "validAfter"), deadline: uint(l.deadline, "deadline"), setupCalls: bytesHex(l.setupCalls, "setupCalls") },
        };
      }
      if (kind !== "execution") throw new Error(`${p}.kind: not execution or bootstrap`);
      const l = object(r, executionKeys, p);
      return {
        kind, hash: word(l.hash, `${p}.hash`), proof: leafWords(l.proof, `${p}.proof`),
        leaf: {
          destination: bytesHex(l.destination, "destination"), nonce: uint(l.nonce, "nonce"), validAfter: uint(l.validAfter, "validAfter"),
          deadline: uint(l.deadline, "deadline"), calls: bytesHex(l.calls, "calls"),
          attributes: array(l.attributes, `${p}.attributes`).map((a, j) => bytesHex(a, `${p}.attributes[${j}]`)),
        },
      };
    }),
  };
}

export function serializeMerklePackage(pkg: MerklePackage): string {
  verifyMerklePackage(pkg);
  return JSON.stringify(merklePackageToJSON(pkg), null, 2) + "\n";
}

export function parseMerklePackage(json: string): MerklePackage {
  const pkg = merklePackageFromJSON(JSON.parse(json));
  verifyMerklePackage(pkg);
  return pkg;
}
