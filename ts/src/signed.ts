import {
  type Address, type Hex, concat, encodeAbiParameters, encodeFunctionData,
  keccak256, parseAbiParameters, zeroAddress, hashTypedData,
} from "viem";
import { type SafeTx, type SafeTxEnvelope } from "./safeTx.js";
import { signedTransmitterAbi, signedReceiverAbi, crossecuteGuardAbi, safeBatchExecutorAbi } from "./signedAbi.js";

export const WIRE_STANDALONE = 1n;
export const WIRE_MERKLE = 2n;

export const PROTOCOL_135_REVISION = "5d7be13e3afccb88c8a1b8a298bc56709706f76c";
export type SafeOwner = { owner: Address; kind: 0 | 1 };
export type SafeAuthorityRecord = { safe: Address; threshold: bigint; owners: readonly SafeOwner[] };
export type SignedSafeTx = { safeTx: SafeTx; signatures: Hex };
export type NestedSafeApproval = { childSafe: Address; messageHash: Hex; approval: SignedSafeTx };
export type SafeTxEvidence = { signedSafeTx: SignedSafeTx; nestedApprovals: readonly NestedSafeApproval[] };
export type ExecutionLeaf = { destination: Hex; nonce: bigint; validAfter: bigint; deadline: bigint; calls: Hex; attributes: readonly Hex[] };
export type BootstrapLeaf = { destination: Hex; validAfter: bigint; deadline: bigint; setupCalls: Hex };
export type SignedBootstrap = { evidence: SafeTxEvidence; records: readonly SafeAuthorityRecord[] };

// Take tuple definitions from the pinned protocol ABI; no independent copy of nested ABI layouts.
const relay = signedTransmitterAbi.find((f) => f.type === "function" && f.name === "relayLeaf")!;
const evidenceType = relay.inputs[0];
const executionType = relay.inputs[1];
const bootstrapType = parseAbiParameters("(bytes destination, uint256 validAfter, uint256 deadline, bytes setupCalls)")[0];
const recordsType = parseAbiParameters("(address safe, uint256 threshold, (address owner, uint8 kind)[] owners)[]")[0];

/** The guard publishes encoded fields, not abi.encode(struct), for each leaf. */
export function encodeExecutionLeaf(leaf: ExecutionLeaf): Hex {
  return encodeAbiParameters(executionType.components, [leaf.destination, leaf.nonce, leaf.validAfter, leaf.deadline, leaf.calls, leaf.attributes]);
}
export function encodeBootstrapLeaf(leaf: BootstrapLeaf): Hex {
  return encodeAbiParameters(bootstrapType.components, [leaf.destination, leaf.validAfter, leaf.deadline, leaf.setupCalls]);
}
export function dispatchLeafHash(encodedFields: Hex): Hex { return keccak256(keccak256(encodedFields)); }
export function executionLeafHash(leaf: ExecutionLeaf): Hex { return dispatchLeafHash(encodeExecutionLeaf(leaf)); }
export function bootstrapLeafHash(leaf: BootstrapLeaf): Hex { return dispatchLeafHash(encodeBootstrapLeaf(leaf)); }
/** Replay identity intentionally excludes delivery attributes, matching DispatchLeaves.executionId. */
export function executionId(leaf: ExecutionLeaf): Hex {
  return dispatchLeafHash(encodeAbiParameters(executionType.components.slice(0, 5), [leaf.destination, leaf.nonce, leaf.validAfter, leaf.deadline, leaf.calls]));
}
function pair(a: Hex, b: Hex): Hex {
  return keccak256(concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));
}
/** Preserves publication order. Odd final nodes move up unchanged; leaves are never sorted. */
export function dispatchTree(leaves: readonly Hex[]): { root: Hex; hashes: Hex[]; proofs: Hex[][] } {
  if (!leaves.length) throw new Error("no leaves");
  const hashes = leaves.map(dispatchLeafHash);
  const levels = [hashes];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  return { root: levels.at(-1)![0], hashes, proofs: hashes.map((_, index) => {
    const proof: Hex[] = [];
    for (const level of levels.slice(0, -1)) {
      const sibling = index ^ 1;
      if (sibling < level.length) proof.push(level[sibling]);
      index = Math.floor(index / 2);
    }
    return proof;
  }) };
}
export function verifyDispatchProof(hash: Hex, proof: readonly Hex[], root: Hex): boolean {
  return proof.reduce(pair, hash).toLowerCase() === root.toLowerCase();
}

/** Hashes supplied canonical records. Use validateAuthorityRecords first for untrusted input. */
export function authorityGraphHash(records: readonly SafeAuthorityRecord[]): Hex {
  return keccak256(encodeAbiParameters([recordsType], [records]));
}
/** Validates recorded owner kinds/thresholds and first-visit DFS order without live RPC queries. */
export function validateAuthorityRecords(records: readonly SafeAuthorityRecord[], root: Address): void {
  if (!records.length || records[0].safe.toLowerCase() !== root.toLowerCase()) throw new Error("wrong authority root");
  const bySafe = new Map(records.map(r => [r.safe.toLowerCase(), r]));
  if (bySafe.size !== records.length) throw new Error("duplicate authority record");
  const visited = new Set<string>(), open = new Set<string>();
  let index = 0;
  function visit(safe: Address): void {
    const key = safe.toLowerCase();
    if (open.has(key)) throw new Error("authority cycle");
    if (visited.has(key)) return;
    const r = bySafe.get(key);
    if (!r) throw new Error("missing authority record");
    if (records[index++] !== r) throw new Error("noncanonical authority order");
    if (r.threshold < 1n || r.threshold > BigInt(r.owners.length)) throw new Error("invalid threshold");
    visited.add(key); open.add(key);
    const owners = new Set<string>();
    for (const o of r.owners) {
      const owner = o.owner.toLowerCase();
      if (BigInt(owner) <= 1n || owner === key || owners.has(owner)) throw new Error("invalid owner");
      owners.add(owner);
      if (o.kind === 1) visit(o.owner);
      else if (o.kind !== 0 || bySafe.has(owner)) throw new Error("invalid owner kind");
    }
    open.delete(key);
  }
  visit(root);
  if (visited.size !== records.length) throw new Error("unreachable authority record");
}
/** This is the conduit salt commitment, not a CREATE2 address prediction. */
export function signedConduitSalt(owner: Address, userSalt: Hex, homeChainKey: Hex, graphHash: Hex): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32, bytes32, bytes32"), [owner, userSalt, homeChainKey, graphHash]));
}
/** Safe child-domain hash approved by SignMessageLib. `message` is the original message bytes. */
export function safeMessageHash(chainId: bigint, childSafe: Address, message: Hex): Hex {
  return hashTypedData({ domain: { chainId, verifyingContract: childSafe }, primaryType: "SafeMessage", types: { SafeMessage: [{ name: "message", type: "bytes" }] }, message: { message } });
}

/** Exact provider wire bytes; supplying evidence does not verify signatures or fetch cached approvals. */
export function encodeStandaloneWire(evidence: SafeTxEvidence): Hex {
  return encodeAbiParameters([{ type: "uint256" }, evidenceType], [WIRE_STANDALONE, evidence]);
}
export function encodeMerkleWire(evidence: SafeTxEvidence, leaf: ExecutionLeaf, proof: readonly Hex[]): Hex {
  return encodeAbiParameters([{ type: "uint256" }, ...relay.inputs], [WIRE_MERKLE, evidence, leaf, proof]);
}
export function encodeSignedBootstrap(body: SignedBootstrap): Hex {
  return encodeAbiParameters([{ type: "tuple", components: [{ ...evidenceType, name: "evidence" }, { ...recordsType, name: "records" }] }], [body]);
}
/** #135 supports authority counter zero only. Bootstrap payload carries a struct, unlike leaf publication. */
export function signedBootstrapData(root: Hex, leaf: BootstrapLeaf, proof: readonly Hex[], attributes: readonly Hex[]): Hex {
  if (!verifyDispatchProof(bootstrapLeafHash(leaf), proof, root)) throw new Error("invalid bootstrap proof");
  const payload = encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, bootstrapType, { type: "bytes32[]" }], [root, 0n, leaf, proof]);
  return encodeFunctionData({ abi: signedTransmitterAbi, functionName: "bootstrap", args: [payload, attributes] });
}
export function signedSendData(destination: Hex, calls: Hex, attributes: readonly Hex[]): Hex {
  if (calls === "0x") throw new Error("empty signed payload");
  return encodeFunctionData({ abi: signedTransmitterAbi, functionName: "sendMessage", args: [destination, calls, attributes] });
}
export function registerRootData(root: Hex): Hex {
  return encodeFunctionData({ abi: signedTransmitterAbi, functionName: "registerRoot", args: [root] });
}
export function publishLeavesData(leaves: readonly Hex[]): Hex {
  if (!leaves.length) throw new Error("no leaves");
  return encodeFunctionData({ abi: crossecuteGuardAbi, functionName: "publishLeaves", args: [leaves] });
}
export function relayLeafData(evidence: SafeTxEvidence, leaf: ExecutionLeaf, proof: readonly Hex[]): Hex {
  return encodeFunctionData({ abi: signedTransmitterAbi, functionName: "relayLeaf", args: [evidence, leaf, proof] });
}
export function submitMessageData(evidence: SafeTxEvidence): Hex {
  return encodeFunctionData({ abi: signedReceiverAbi, functionName: "submitMessage", args: [evidence] });
}
export function submitLeafData(evidence: SafeTxEvidence, leaf: ExecutionLeaf, proof: readonly Hex[]): Hex {
  return encodeFunctionData({ abi: signedReceiverAbi, functionName: "submitLeaf", args: [evidence, leaf, proof] });
}
/** A separately signed CALL at its own Safe nonce. Never wrap signed sends in MultiSend. */
export function signedDispatchTx(chainId: bigint, safe: Address, transmitter: Address, nonce: bigint, data: Hex, value = 0n): SafeTxEnvelope {
  if (chainId <= 0n || chainId >= 2n ** 256n) throw new Error("invalid source chain id");
  if (nonce < 0n || nonce >= 2n ** 256n || value < 0n || value >= 2n ** 256n) throw new Error("invalid Safe nonce or value");
  return { chainId, safe, tx: { to: transmitter, value, data, nonce, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress } };
}
/** Atomic source submission of separately signed Safe transactions, in consecutive nonce order per Safe. */
export function safeBatchData(executions: readonly { envelope: SafeTxEnvelope; signatures: Hex }[]): Hex {
  if (!executions.length) throw new Error("no executions");
  const next = new Map<string, bigint>();
  const chain = executions[0].envelope.chainId;
  const entries = executions.map(({ envelope, signatures }) => {
    if (envelope.chainId !== chain) throw new Error("mixed source chains");
    if (envelope.tx.nonce < 0n || envelope.tx.nonce >= 2n ** 256n) throw new Error("invalid Safe nonce");
    const key = envelope.safe.toLowerCase(), expected = next.get(key);
    if (expected !== undefined && envelope.tx.nonce !== expected) throw new Error("nonconsecutive Safe nonce");
    next.set(key, envelope.tx.nonce + 1n);
    const { nonce: _, ...tx } = envelope.tx;
    return { safe: envelope.safe, ...tx, signatures };
  });
  return encodeFunctionData({ abi: safeBatchExecutorAbi, functionName: "execute", args: [entries] });
}
