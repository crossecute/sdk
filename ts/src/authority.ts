import {
  type Address, type Hex, type PublicClient, BaseError, ContractFunctionRevertedError, concatHex, decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeAbiParameters,
  encodeFunctionData, encodePacked, isAddressEqual, keccak256, parseAbi, sliceHex, size, toFunctionSelector, zeroHash,
} from "viem";
import { type Call, encodeEvm } from "./encoding.js";
import { type SafeTxEnvelope, safeTxHashes } from "./safeTx.js";
import {
  type AuthorityGraph, type NestedSafeApproval, authorityGraphHash, authorityRecordHash, signedDispatchTx,
  validateAuthorityGraph, safeMessageHash,
} from "./signed.js";
import { signedReceiverAbi, signedTransmitterAbi, sourceAuthorityGuardAbi } from "./signedAbi.js";

const multicallAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
  "function aggregate((address target, bytes callData)[] calls) payable returns (uint256 blockNumber, bytes[] returnData)",
  "function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
]);
const safeAbi = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "function multiSend(bytes transactions) payable",
  "function checkSignatures(address executor, bytes32 dataHash, bytes signatures) view",
]);
const mutationLengths = new Map(parseAbi([
  "function addOwnerWithThreshold(address owner, uint256 threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 threshold)",
]).map((item) => [toFunctionSelector(item), 4 + item.inputs.length * 32]));
const packedCallHeader = 1 + 20 + 32 + 32;
const registrationSize = 4 + 2 * 32;
const submissionTypes = signedReceiverAbi.find((entry) => entry.name === "submitAuthority")!.inputs;
export type AuthoritySubmission = ReturnType<typeof decodeAuthoritySubmission>;
export type ChildUpdate = AuthoritySubmission["childUpdates"][number];
export type AuthoritySelection = { updateHead: Hex; authorityHash: Hex };

export function decodeAuthoritySubmission(bytes: Hex) {
  const [evidence, newGraph, childUpdates] = decodeAbiParameters(submissionTypes, bytes);
  if (encodeAbiParameters(submissionTypes, [evidence, newGraph, childUpdates]) !== bytes.toLowerCase()) {
    throw new Error("noncanonical authority submission");
  }
  return { evidence, newGraph: checkedGraph(newGraph), childUpdates };
}

function checkedGraph(graph: { nodes: readonly { record: { owners: readonly { kind: number }[] } }[] }): AuthorityGraph {
  if (graph.nodes.some(({ record }) => record.owners.some(({ kind }) => kind !== 0 && kind !== 1))) {
    throw new Error("unknown authority owner kind");
  }
  return graph as AuthorityGraph;
}

/** Source data for the Safe proposal and its atomic outer execution. */
export type AuthorityProposal = {
  envelope: SafeTxEnvelope;
  guard: Address;
  currentGraph: AuthorityGraph;
  newGraph: AuthorityGraph;
  childUpdates: readonly ChildUpdate[];
};

function packCall({ target, value, data }: Call): Hex {
  return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, target, value, BigInt(size(data)), data]);
}

type AuthorityAction =
  | { kind: "activate" }
  | { kind: "adopt" }
  | { kind: "ownership"; multiSend: Address; mutations: readonly Hex[] };

export function buildAuthorityProposal({
  chainId, safe, nonce, guard, selection, currentGraph, newGraph, action, childUpdates = [],
}: {
  chainId: bigint;
  safe: Address;
  nonce: bigint;
  guard: Address;
  selection: AuthoritySelection;
  currentGraph: AuthorityGraph;
  newGraph: AuthorityGraph;
  action: AuthorityAction;
  childUpdates?: readonly ChildUpdate[];
}): AuthorityProposal {
  validateAuthorityGraph(newGraph, safe);
  const newAuthorityHash = authorityGraphHash(chainId, newGraph);
  if (action.kind === "activate") {
    if (selection.authorityHash !== zeroHash || selection.updateHead !== zeroHash ||
        currentGraph.nodes.length || childUpdates.length) throw new Error("activation requires an empty selection and witness");
    const data = encodeFunctionData({ abi: sourceAuthorityGuardAbi, functionName: "activate", args: [newAuthorityHash] });
    return { envelope: signedDispatchTx(chainId, safe, guard, nonce, data), guard, currentGraph, newGraph, childUpdates };
  }
  validateAuthorityGraph(currentGraph, safe);
  if (selection.updateHead === zeroHash || authorityGraphHash(chainId, currentGraph) !== selection.authorityHash) {
    throw new Error("authority witness does not match the source selection");
  }
  const update = { previousUpdateHash: selection.updateHead, newAuthorityHash };
  if (action.kind === "adopt") {
    const data = encodeFunctionData({ abi: sourceAuthorityGuardAbi, functionName: "selectAuthority", args: [update] });
    return { envelope: signedDispatchTx(chainId, safe, guard, nonce, data), guard, currentGraph, newGraph, childUpdates };
  }
  if (!action.mutations.length || action.mutations.some((data) => mutationLengths.get(sliceHex(data, 0, 4)) !== size(data))) {
    throw new Error("ownership changes require valid Safe owner mutations");
  }
  const registration = encodeFunctionData({
    abi: sourceAuthorityGuardAbi, functionName: "registerOwnershipChange", args: [update],
  });
  const packed = [
    packCall({ target: guard, value: 0n, data: registration }),
    ...action.mutations.map((data) => packCall({ target: safe, value: 0n, data })),
  ];
  const data = encodeFunctionData({ abi: safeAbi, functionName: "multiSend", args: [`0x${packed.map((part) => part.slice(2)).join("")}`] });
  const envelope = signedDispatchTx(chainId, safe, action.multiSend, nonce, data);
  envelope.tx.operation = 1;
  return { envelope, guard, currentGraph, newGraph, childUpdates };
}

export function authorityExecution(
  proposal: AuthorityProposal,
  multicall: Address,
  liveSignatures: Hex,
  portableSignatures: Hex = liveSignatures,
  nestedApprovals: readonly NestedSafeApproval[] = [],
): Call {
  const { envelope: { safe, tx }, guard, currentGraph, newGraph, childUpdates } = proposal;
  if (tx.safeTxGas !== 0n || tx.gasPrice !== 0n) throw new Error("Safe execution must revert on failure");
  if (liveSignatures === "0x" || portableSignatures === "0x") throw new Error("missing authority signatures");
  const stage = encodeFunctionData({
    abi: sourceAuthorityGuardAbi, functionName: "stageUpdate",
    args: [safe, currentGraph, newGraph, childUpdates, portableSignatures, nestedApprovals],
  });
  const exec = encodeFunctionData({
    abi: safeAbi, functionName: "execTransaction",
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, liveSignatures],
  });
  return { target: multicall, value: 0n, data: encodeFunctionData({
    abi: multicallAbi, functionName: "aggregate3",
    args: [[{ target: guard, callData: stage, allowFailure: false }, { target: safe, callData: exec, allowFailure: false }]],
  }) };
}

/**
 * Reuses portable signatures when the live Safe accepts them. The callback can reuse the
 * operation's existing signing workflow and is called only after a live signature revert.
 */
export async function prepareAuthorityExecution({
  rpc, proposal, multicall, portableSignatures, nestedApprovals, collectLiveSignatures,
}: {
  rpc: Pick<PublicClient, "readContract" | "call">;
  proposal: AuthorityProposal;
  multicall: Address;
  portableSignatures: Hex;
  nestedApprovals?: readonly NestedSafeApproval[];
  collectLiveSignatures: (envelope: SafeTxEnvelope) => Promise<Hex>;
}): Promise<Call> {
  const { envelope } = proposal;
  const { safeTxHash } = safeTxHashes(envelope);
  const check = (signatures: Hex) => rpc.readContract({
    address: envelope.safe, abi: safeAbi, functionName: "checkSignatures",
    args: [multicall, safeTxHash, signatures],
  });
  let live = portableSignatures;
  try {
    await check(live);
  } catch (error) {
    if (!(error instanceof BaseError) || !(error.walk((cause) =>
      cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError)) throw error;
    live = await collectLiveSignatures(envelope);
    await check(live);
  }
  const execution = authorityExecution(proposal, multicall, live, portableSignatures, nestedApprovals);
  const { data } = await rpc.call({ to: execution.target, data: execution.data, value: execution.value });
  if (!data) throw new Error("atomic executor returned no simulation result");
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data });
  if (results.length !== 2 || results.some(({ success }) => !success) ||
      !decodeFunctionResult({ abi: safeAbi, functionName: "execTransaction", data: results[1].returnData })) {
    throw new Error("atomic authority simulation failed");
  }
  return execution;
}

const stageSelector = toFunctionSelector(sourceAuthorityGuardAbi.find((entry) => entry.name === "stageUpdate")!);
const authorityPublished = sourceAuthorityGuardAbi.find((entry) => entry.name === "AuthorityPublished")!;
const authorityExecuted = sourceAuthorityGuardAbi.find((entry) => entry.name === "AuthorityUpdateExecuted")!;

function predecessor(submission: AuthoritySubmission, guard: Address): Hex {
  const { to, data, operation } = submission.evidence.signedSafeTx.safeTx;
  if (operation === 0 && isAddressEqual(to, guard)) {
    const update = decodeFunctionData({ abi: sourceAuthorityGuardAbi, data });
    if (update.functionName === "selectAuthority") return update.args[0].previousUpdateHash;
  }
  if (operation === 1) {
    const packed = decodeFunctionData({ abi: safeAbi, data });
    if (packed.functionName === "multiSend") {
      const [calls] = packed.args;
      const registration = decodeFunctionData({ abi: sourceAuthorityGuardAbi, data: sliceHex(calls, packedCallHeader, packedCallHeader + registrationSize) });
      if (registration.functionName === "registerOwnershipChange" &&
          isAddressEqual(sliceHex(calls, 1, 21), guard)) return registration.args[0].previousUpdateHash;
    }
  }
  throw new Error("published submission does not contain a recognized authority successor");
}

type AuthorityRpc = Pick<PublicClient, "readContract" | "getLogs" | "getTransaction">;

export type PublishedAuthority = AuthoritySubmission & {
  bytes: Hex;
  updateHead: Hex;
  previousUpdateHash: Hex;
  blockNumber: bigint;
  logIndex: number;
};

/** Binds RPC reads to one source block. fromBlock is the earliest possible guard execution. */
export class AuthoritySource {
  constructor(
    private readonly rpc: AuthorityRpc,
    readonly chainId: bigint,
    readonly guard: Address,
    readonly blockNumber: bigint,
    readonly fromBlock: bigint,
    readonly logRange = 10_000n,
  ) {
    if (fromBlock < 0n || blockNumber < fromBlock || logRange <= 0n) throw new Error("invalid authority RPC history bounds");
  }

  selection(sourceSafe: Address): Promise<AuthoritySelection> {
    return this.rpc.readContract({
      address: this.guard, abi: sourceAuthorityGuardAbi, functionName: "selection",
      args: [sourceSafe], blockNumber: this.blockNumber,
    });
  }

  private async findLog<Log>(
    name: string, sourceSafe: Address, updateHead: Hex,
    search: (fromBlock: bigint, toBlock: bigint) => Promise<readonly Log[]>,
  ): Promise<Log> {
    for (let end = this.blockNumber; end >= this.fromBlock;) {
      const start = end - this.fromBlock >= this.logRange ? end - this.logRange + 1n : this.fromBlock;
      const hits = await search(start, end);
      if (hits.length > 1) throw new Error(`multiple ${name} logs for ${updateHead}`);
      if (hits.length === 1) return hits[0];
      end = start - 1n;
    }
    throw new Error(`RPC history is missing ${name} for ${sourceSafe} at ${updateHead}`);
  }

  async submission(sourceSafe: Address, updateHead: Hex): Promise<PublishedAuthority> {
    const hash = await this.rpc.readContract({
      address: this.guard, abi: sourceAuthorityGuardAbi, functionName: "publishedAuthority",
      args: [sourceSafe, updateHead], blockNumber: this.blockNumber,
    });
    if (hash === zeroHash) throw new Error(`no source publication for ${sourceSafe} at ${updateHead}`);
    const log = await this.findLog(authorityPublished.name, sourceSafe, updateHead, (fromBlock, toBlock) => this.rpc.getLogs({
      address: this.guard, event: authorityPublished, args: { sourceSafe, updateHead }, fromBlock, toBlock, strict: true,
    }));
    const { submission: bytes } = log.args;
    if (keccak256(bytes) !== hash) throw new Error(`authority publication hash mismatch for ${updateHead}`);
    const submission = decodeAuthoritySubmission(bytes);
    const actualHead = submissionHash(this.chainId, sourceSafe, submission.evidence.signedSafeTx.safeTx);
    if (actualHead !== updateHead) throw new Error(`authority submission has the wrong Safe transaction hash for ${updateHead}`);
    validateAuthorityGraph(submission.newGraph, sourceSafe);
    return {
      ...submission, bytes, updateHead, previousUpdateHash: predecessor(submission, this.guard),
      blockNumber: log.blockNumber, logIndex: log.logIndex,
    };
  }

  async witness(sourceSafe: Address, selected: AuthoritySelection): Promise<AuthorityGraph> {
    if (selected.authorityHash === zeroHash && selected.updateHead === zeroHash) return { nodes: [] };
    const published = await this.rpc.readContract({
      address: this.guard, abi: sourceAuthorityGuardAbi, functionName: "publishedAuthority",
      args: [sourceSafe, selected.updateHead], blockNumber: this.blockNumber,
    });
    let graph: AuthorityGraph;
    if (published !== zeroHash) {
      graph = (await this.submission(sourceSafe, selected.updateHead)).newGraph;
    } else {
      const updateHead = selected.updateHead;
      const log = await this.findLog(authorityExecuted.name, sourceSafe, updateHead, (fromBlock, toBlock) => this.rpc.getLogs({
        address: this.guard, event: authorityExecuted, args: { sourceSafe, updateHead }, fromBlock, toBlock, strict: true,
      }));
      if (log.args.authorityHash !== selected.authorityHash) throw new Error("activation log has the wrong authority hash");
      const transaction = await this.rpc.getTransaction({ hash: log.transactionHash });
      const decodedBatch = decodeFunctionData({ abi: multicallAbi, data: transaction.input });
      const calls = decodedBatch.functionName === "tryAggregate" ? decodedBatch.args[1] : decodedBatch.args[0];
      const stage = calls.find(({ target, callData }) => isAddressEqual(target, this.guard) &&
        sliceHex(callData, 0, 4) === stageSelector &&
        isAddressEqual(sliceHex(callData, 16, 36), sourceSafe));
      if (!stage) throw new Error("activation transaction is missing the Safe's staging call");
      const decoded = decodeFunctionData({ abi: sourceAuthorityGuardAbi, data: stage.callData });
      if (decoded.functionName !== "stageUpdate") throw new Error("invalid activation staging call");
      graph = checkedGraph(decoded.args[2]);
    }
    validateAuthorityGraph(graph, sourceSafe);
    if (authorityGraphHash(this.chainId, graph) !== selected.authorityHash) {
      throw new Error(`authority witness hash mismatch for ${sourceSafe} at ${selected.updateHead}`);
    }
    return graph;
  }

  /** Walks the published source history from the requested target back to the receiver's head. */
  async successors(sourceSafe: Address, fromHead: Hex, toHead: Hex): Promise<PublishedAuthority[]> {
    if (fromHead === zeroHash || toHead === zeroHash) throw new Error("catch-up requires initialized authority heads");
    const updates: PublishedAuthority[] = [];
    const seen = new Set<Hex>();
    for (let head = toHead; head !== fromHead;) {
      if (seen.has(head)) throw new Error("cycle in published authority history");
      seen.add(head);
      const update = await this.submission(sourceSafe, head);
      updates.push(update);
      head = update.previousUpdateHash;
    }
    return updates.reverse();
  }
}

export async function planAuthorityProposal(
  source: AuthoritySource,
  input: Pick<Parameters<typeof buildAuthorityProposal>[0], "safe" | "nonce" | "newGraph" | "action" | "childUpdates">,
): Promise<AuthorityProposal> {
  const selection = await source.selection(input.safe);
  const currentGraph = await source.witness(input.safe, selection);
  const childUpdates = input.childUpdates ?? await planChildUpdates(source, currentGraph, input.newGraph);
  return buildAuthorityProposal({ ...input, selection, currentGraph, childUpdates, chainId: source.chainId, guard: source.guard });
}

function submissionHash(chainId: bigint, safe: Address, tx: AuthoritySubmission["evidence"]["signedSafeTx"]["safeTx"]): Hex {
  const { operation } = tx;
  if (operation !== 0 && operation !== 1) throw new Error("invalid operation in authority submission");
  return safeTxHashes({ chainId, safe, tx: { ...tx, operation } }).safeTxHash;
}

/** Proves retained positions and the nested positions used by each published child vote. */
export async function planChildUpdates(
  source: AuthoritySource, currentGraph: AuthorityGraph, newGraph: AuthorityGraph,
): Promise<ChildUpdate[]> {
  const selected = new Map(currentGraph.nodes.slice(1).map((node) => [node.record.safe.toLowerCase(), node]));
  const proven = new Map<string, AuthorityGraph["nodes"][number]["record"]>();
  const open = new Set<string>();
  const result: ChildUpdate[] = [];
  const key = (safe: Address, position: Hex) => `${safe.toLowerCase()}:${position}`;
  for (const [safe, node] of selected) proven.set(`${safe}:${node.position}`, node.record);

  async function prove(safe: Address, position: Hex): Promise<AuthorityGraph["nodes"][number]["record"]> {
    const id = key(safe, position);
    const existing = proven.get(id);
    if (existing) return existing;
    if (!selected.has(safe.toLowerCase())) throw new Error(`no selected predecessor for nested voter ${safe}`);
    if (open.has(id)) throw new Error(`circular child update proof at ${id}`);
    open.add(id);

    const update = await source.submission(safe, position);
    const prior = await prove(safe, update.previousUpdateHash);
    const positions = new Map(update.newGraph.nodes.slice(1).map((node) => [node.record.safe.toLowerCase(), node]));
    const { evidence } = update;

    async function proveVoters(signatures: Hex, digest: Hex, threshold: bigint) {
      for (let i = 0; i < Number(threshold); i++) {
        const offset = i * 65;
        if (sliceHex(signatures, offset + 64, offset + 65) !== "0x00") continue;
        const child = sliceHex(signatures, offset + 12, offset + 32);
        const named = positions.get(child.toLowerCase());
        if (!named) throw new Error(`published vote does not name nested voter ${child}`);
        const record = await prove(child, named.position);
        if (authorityRecordHash(record) !== authorityRecordHash(named.record)) throw new Error("nested voter record mismatch");
        const at = Number(BigInt(sliceHex(signatures, offset + 32, offset + 64)));
        const length = Number(BigInt(sliceHex(signatures, at, at + 32)));
        const messageHash = safeMessageHash(source.chainId, child, digest);
        if (length) {
          await proveVoters(sliceHex(signatures, at + 32, at + 32 + length), messageHash, record.threshold);
        } else {
          const cached = evidence.nestedApprovals.find((approval) =>
            isAddressEqual(approval.childSafe, child) && approval.messageHash === messageHash);
          if (!cached) throw new Error(`published vote is missing approval for ${child}`);
          const approvalHash = submissionHash(source.chainId, child, cached.approval.safeTx);
          await proveVoters(cached.approval.signatures, approvalHash, record.threshold);
        }
      }
    }

    await proveVoters(evidence.signedSafeTx.signatures, position, prior.threshold);
    const newRecord = update.newGraph.nodes[0].record;
    result.push({
      sourceSafe: safe, evidence, newRecord,
      newGraphEntries: update.newGraph.nodes.map((node) => ({
        position: node.position, recordHash: authorityRecordHash(node.record),
      })),
    });
    open.delete(id);
    proven.set(id, newRecord);
    return newRecord;
  }

  for (const { record, position } of newGraph.nodes.slice(1)) {
    if (!selected.has(record.safe.toLowerCase())) continue;
    const provenRecord = await prove(record.safe, position);
    if (authorityRecordHash(provenRecord) !== authorityRecordHash(record)) throw new Error("retained child record mismatch");
  }
  return result;
}

export function submitAuthorityData(update: PublishedAuthority): Hex {
  const submit = signedReceiverAbi.find((entry) => entry.name === "submitAuthority")!;
  return concatHex([toFunctionSelector(submit), update.bytes]);
}

export function submitAuthorityBatchData(updates: readonly PublishedAuthority[]): Hex {
  if (!updates.length) throw new Error("no authority successors");
  for (let i = 1; i < updates.length; i++) {
    if (updates[i].previousUpdateHash !== updates[i - 1].updateHead) throw new Error("nonconsecutive authority successors");
  }
  return encodeFunctionData({
    abi: signedReceiverAbi, functionName: "submitAuthorityBatch", args: [updates.map(({ bytes }) => bytes)],
  });
}

/** A Safe can fund and send the next provider relay with a direct CALL. */
export async function buildAuthorityRelayProposal({
  rpc, chainId, safe, nonce, transmitter, recipient, attributes, update, blockNumber, quoteAccount = safe,
}: {
  rpc: Pick<PublicClient, "readContract">;
  chainId: bigint;
  safe: Address;
  nonce: bigint;
  transmitter: Address;
  recipient: Hex;
  attributes: readonly Hex[];
  update: PublishedAuthority;
  blockNumber: bigint;
  quoteAccount?: Address;
}): Promise<SafeTxEnvelope> {
  const args = [recipient, update.bytes, attributes] as const;
  const value = await rpc.readContract({
    address: transmitter, abi: signedTransmitterAbi, functionName: "quoteAuthority", args, blockNumber, account: quoteAccount,
  });
  const data = encodeFunctionData({ abi: signedTransmitterAbi, functionName: "relayAuthority", args });
  return signedDispatchTx(chainId, safe, transmitter, nonce, data, value);
}

export function receiverAuthoritySelection(
  rpc: Pick<PublicClient, "readContract">, receiver: Address, blockNumber?: bigint,
): Promise<AuthoritySelection> {
  return rpc.readContract({ address: receiver, abi: signedReceiverAbi, functionName: "selection", blockNumber });
}

/** Warn when a child has advanced independently of its parent's selected graph. */
export async function staleAuthorityChildren(source: AuthoritySource, graph: AuthorityGraph) {
  const stale = [];
  for (const node of graph.nodes.slice(1)) {
    const latest = await source.selection(node.record.safe);
    if (latest.updateHead !== node.position) stale.push({ safe: node.record.safe, selectedHead: node.position, latest });
  }
  return stale;
}

export async function planAuthorityCatchUp({
  source, sourceRpc, receiverRpc, safe, nonce, transmitter, receiver, destinationChainId, destinationBlock, attributes = [],
}: {
  source: AuthoritySource;
  sourceRpc: Pick<PublicClient, "readContract">;
  receiverRpc: Pick<PublicClient, "readContract">;
  safe: Address;
  nonce: bigint;
  transmitter: Address;
  receiver: Address;
  destinationChainId: bigint;
  destinationBlock: bigint;
  attributes?: readonly Hex[];
}) {
  const [selected, destination, recipient, recognized, sourceGuard] = await Promise.all([
    source.selection(safe),
    receiverAuthoritySelection(receiverRpc, receiver, destinationBlock),
    sourceRpc.readContract({
      address: transmitter, abi: signedTransmitterAbi, functionName: "recipientOn",
      args: [destinationChainId], blockNumber: source.blockNumber,
    }),
    receiverRpc.readContract({
      address: receiver, abi: signedReceiverAbi, functionName: "isSourceTransmitter",
      args: [transmitter], blockNumber: destinationBlock,
    }),
    receiverRpc.readContract({
      address: receiver, abi: signedReceiverAbi, functionName: "SOURCE_AUTHORITY_GUARD", blockNumber: destinationBlock,
    }),
  ]);
  if (!recognized || !isAddressEqual(sourceGuard, source.guard) || recipient !== encodeEvm(destinationChainId, receiver)) {
    throw new Error("transmitter and receiver route mismatch");
  }
  const updates = await source.successors(safe, destination.updateHead, selected.updateHead);
  const update = updates[0];
  if (!update) {
    if (selected.authorityHash !== destination.authorityHash) throw new Error("authority hash mismatch at the same head");
    return { status: "current" as const, destination };
  }

  // Re-plan after delivery so every proposal starts at the receiver's actual head.
  const envelope = await buildAuthorityRelayProposal({
    rpc: sourceRpc, chainId: source.chainId, safe, nonce, transmitter, recipient, attributes, update,
    blockNumber: source.blockNumber,
  });
  return {
    status: "lagging" as const, destination, updates, envelope, recipient, receiver, update, attributes,
    sourceBlock: source.blockNumber, destinationChainId, destinationBlock,
    expected: { updateHead: update.updateHead, authorityHash: authorityGraphHash(source.chainId, update.newGraph) },
  };
}

export async function authorityRelayDelivered(
  rpc: Pick<PublicClient, "readContract">, receiver: Address, expected: AuthoritySelection, blockNumber?: bigint,
): Promise<boolean> {
  const actual = await receiverAuthoritySelection(rpc, receiver, blockNumber);
  return actual.updateHead === expected.updateHead && actual.authorityHash === expected.authorityHash;
}

export type AuthorityRelayPlan = Extract<Awaited<ReturnType<typeof planAuthorityCatchUp>>, { status: "lagging" }>;

/** One independently deliverable successor per receiver. Use a CALL-based value multicall. */
export async function buildAuthorityRelayBatch(
  plans: readonly AuthorityRelayPlan[], multicall: Address, rpc: Pick<PublicClient, "readContract">,
): Promise<SafeTxEnvelope> {
  if (!plans.length) throw new Error("no authority relay plans");
  const { envelope, sourceBlock } = plans[0];
  const { chainId, safe, tx: { nonce } } = envelope;
  const receivers = new Set<string>();
  for (const plan of plans) {
    const { envelope: next } = plan;
    if (next.chainId !== chainId || !isAddressEqual(next.safe, safe) || next.tx.nonce !== nonce ||
        plan.sourceBlock !== sourceBlock) throw new Error("relay proposals must share a source Safe, nonce and block");
    const key = `${plan.destinationChainId}:${plan.receiver.toLowerCase()}`;
    if (receivers.has(key)) throw new Error("batch must have at most one successor per receiver");
    receivers.add(key);
  }
  const calls = [];
  let total = 0n;
  for (const { envelope: { tx }, recipient, attributes, update } of plans) {
    const relay = await buildAuthorityRelayProposal({
      rpc, chainId, safe, nonce, transmitter: tx.to, recipient, attributes, update,
      blockNumber: sourceBlock, quoteAccount: multicall,
    });
    total += relay.tx.value;
    calls.push({ target: relay.tx.to, value: relay.tx.value, callData: relay.tx.data, allowFailure: false });
  }
  const data = encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3Value", args: [calls] });
  return signedDispatchTx(chainId, safe, multicall, nonce, data, total);
}
