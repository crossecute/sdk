import { readFileSync } from "node:fs";
import {
  type Address, type Hex, ContractFunctionRevertedError, concatHex, decodeFunctionData, encodeAbiParameters,
  encodeFunctionData, encodeFunctionResult, keccak256, pad, parseAbi, size, toHex, zeroHash,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthorityGraph, type AuthorityRelayPlan, type NestedSafeApproval, AuthoritySource, authorityExecution, authorityGraphHash, buildAuthorityProposal, buildAuthorityRelayBatch,
  buildAuthorityRelayProposal, encodeEvm, planAuthorityCatchUp, planAuthorityProposal, prepareAuthorityExecution, staleAuthorityChildren, safeMessageHash, safeTxHashes, scaffoldAuthorityRelay, scaffoldAuthorityRelayBatch,
  signedDispatchTx, signedReceiverAbi, signedTransmitterAbi, sourceAuthorityGuardAbi, submitAuthorityBatchCalldata,
} from "../src/index.js";

const address = (n: number) => toHex(n, { size: 20 }) as Address;
const [safe, guard, multicall, owner, newOwner, transmitter, receiver, child] =
  Array.from({ length: 8 }, (_, i) => address(i + 2));
const chainId = 10n;
const oldHead = toHex(1, { size: 32 });
const signature = concatHex([toHex(1, { size: 64 }), "0x1b"]);
const liveSignature = concatHex([toHex(2, { size: 64 }), "0x1b"]);
const graphFor = (safe: Address, owner: Address): AuthorityGraph => ({
  nodes: [{ position: zeroHash, record: { safe, owners: [{ owner, kind: 0 }], threshold: 1n } }],
});
const base = { chainId, safe, guard, nonce: 8n };
const graph = graphFor(safe, owner);
const selection = { updateHead: oldHead, authorityHash: authorityGraphHash(chainId, graph) };

const aggregate = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable",
]);
const exec = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);
const mutations = parseAbi(["function swapOwner(address previousOwner,address oldOwner,address newOwner)"]);
const fields = signedReceiverAbi.find((entry) => entry.name === "submitAuthority")!.inputs;

type Votes = { signatures: Hex; nestedApprovals: NestedSafeApproval[] };

function published(
  nonce: bigint, currentGraph = graph, updateHead = oldHead, sourceSafe = safe, updated = currentGraph,
  sign: (head: Hex) => Votes = () => ({ signatures: signature, nestedApprovals: [] }),
) {
  const draft = buildAuthorityProposal({
    ...base, safe: sourceSafe, nonce, currentGraph, newGraph: updated,
    selection: { updateHead, authorityHash: authorityGraphHash(chainId, currentGraph) },
    action: { kind: "select" },
  });
  const head = safeTxHashes(draft.envelope).safeTxHash;
  const votes = sign(head);
  const evidence = { signedSafeTx: { safeTx: draft.envelope.tx, signatures: votes.signatures }, nestedApprovals: votes.nestedApprovals };
  const bytes = encodeAbiParameters(fields, [evidence, updated, []]);
  return { head, bytes, draft };
}

describe("authority updates", () => {
  it("stages activation and executes the Safe in order with separate signature blobs", () => {
    const draft = buildAuthorityProposal({
      ...base, selection: { updateHead: zeroHash, authorityHash: zeroHash },
      currentGraph: { nodes: [] }, newGraph: graph, action: { kind: "activate" },
    });
    const execution = authorityExecution(draft, multicall, liveSignature, signature);
    const [calls] = decodeFunctionData({ abi: aggregate, data: execution.data }).args;
    expect(calls.map(({ target, allowFailure }) => [target.toLowerCase(), allowFailure])).toEqual([
      [guard.toLowerCase(), false], [safe.toLowerCase(), false],
    ]);
    expect(decodeFunctionData({ abi: sourceAuthorityGuardAbi, data: calls[0].callData }).args?.slice(1, 5))
      .toEqual([{ nodes: [] }, graph, [], signature]);
    expect(decodeFunctionData({ abi: exec, data: calls[1].callData }).args.at(-1)).toBe(liveSignature);
  });

  it("keeps the portable set and asks for fresh signatures only after a live revert", async () => {
    const { draft: proposal } = published(8n);
    const readContract = vi.fn().mockResolvedValue(undefined);
    const result = encodeFunctionResult({
      abi: aggregate, functionName: "aggregate3", result: [
        { success: true, returnData: "0x" },
        { success: true, returnData: encodeFunctionResult({ abi: exec, functionName: "execTransaction", result: true }) },
      ],
    });
    const call = vi.fn().mockResolvedValue({ data: result });
    const collectLiveSignatures = vi.fn().mockResolvedValue(liveSignature);
    const input = { rpc: { readContract, call }, proposal, multicall, portableSignatures: signature, collectLiveSignatures };
    await expect(prepareAuthorityExecution(input)).resolves.toEqual(authorityExecution(proposal, multicall, signature));
    expect(collectLiveSignatures).not.toHaveBeenCalled();

    readContract.mockRejectedValueOnce(new ContractFunctionRevertedError({
      abi: [], functionName: "checkSignatures", message: "GS026",
    }));
    await expect(prepareAuthorityExecution(input))
      .resolves.toEqual(authorityExecution(proposal, multicall, liveSignature, signature));
    expect(collectLiveSignatures).toHaveBeenCalledExactlyOnceWith(proposal.envelope);
    expect(call).toHaveBeenCalledTimes(2);

    readContract.mockRejectedValueOnce(new Error("RPC disconnected"));
    await expect(prepareAuthorityExecution(input)).rejects.toThrow("RPC disconnected");
    expect(collectLiveSignatures).toHaveBeenCalledTimes(1);
    call.mockResolvedValueOnce({ data: undefined });
    await expect(prepareAuthorityExecution(input)).rejects.toThrow("no simulation result");
  });

  it("retrieves the activation witness from the staged transaction and rejects a mismatch", async () => {
    const draft = buildAuthorityProposal({
      ...base, selection: { updateHead: zeroHash, authorityHash: zeroHash },
      currentGraph: { nodes: [] }, newGraph: graph, action: { kind: "activate" },
    });
    const execution = authorityExecution(draft, multicall, signature);
    const updateHead = safeTxHashes(draft.envelope).safeTxHash;
    const readContract = vi.fn().mockResolvedValue(zeroHash);
    const getLogs = vi.fn().mockResolvedValue([{ args: { authorityHash: selection.authorityHash }, transactionHash: updateHead }]);
    const getTransaction = vi.fn().mockResolvedValue({ input: execution.data });
    const source = new AuthoritySource({ readContract, getLogs, getTransaction }, chainId, guard, 100n, 0n);
    await expect(source.witness(safe, { updateHead, authorityHash: selection.authorityHash })).resolves.toEqual(graph);
    getLogs.mockResolvedValueOnce([{ args: { authorityHash: oldHead }, transactionHash: updateHead }]);
    await expect(source.witness(safe, { updateHead, authorityHash: oldHead })).rejects.toThrow("witness hash mismatch");
  });

  it("commits an ownership mutation and rejects a stale witness", () => {
    const input = {
      ...base, selection, currentGraph: graph, newGraph: graphFor(safe, newOwner),
      action: { kind: "ownership" as const, multiSend: multicall, mutations: [encodeFunctionData({
        abi: mutations, functionName: "swapOwner", args: [address(1), owner, newOwner],
      })] },
    };
    expect(buildAuthorityProposal(input).envelope.tx).toMatchObject({ operation: 1, to: multicall });
    expect(() => buildAuthorityProposal({ ...input, selection: { ...selection, authorityHash: oldHead } }))
      .toThrow("witness does not match");
  });

  it("retrieves and authenticates each publication, then plans only the next provider relay", async () => {
    const first = published(8n);
    const second = published(9n, graph, first.head);
    const submissions = new Map([[first.head, first.bytes], [second.head, second.bytes]]);
    const recipient = encodeEvm(8453n, receiver);
    const sourceRpc = {
      readContract: vi.fn().mockImplementation(async ({ functionName, args }) => {
        if (functionName === "selection") return { ...selection, updateHead: second.head };
        if (functionName === "publishedAuthority") return keccak256(submissions.get(args[1])!);
        if (functionName === "recipientOn") return recipient;
        if (functionName === "quoteAuthority") return 17n;
        throw new Error(functionName);
      }),
      getLogs: vi.fn().mockImplementation(async ({ args }) => [{
        args: { submission: submissions.get(args.updateHead) }, blockNumber: 4n, logIndex: 0,
      }]),
      getTransaction: vi.fn(),
    };
    const receiverRpc = {
      readContract: vi.fn().mockImplementation(async ({ functionName }) => functionName === "selection" ? selection : functionName === "SOURCE_AUTHORITY_GUARD" ? guard : true),
    };
    const source = new AuthoritySource(sourceRpc, chainId, guard, 10n, 0n);
    const plan = await planAuthorityCatchUp({
      source, sourceRpc, receiverRpc, safe, nonce: 10n, transmitter, receiver,
      destinationChainId: 8453n, destinationBlock: 12n,
    });
    expect(plan.status).toBe("lagging");
    if (plan.status !== "lagging") throw new Error("expected receiver to be lagging");
    expect(plan.updates.map(({ updateHead }) => updateHead)).toEqual([first.head, second.head]);
    expect(plan.expected.updateHead).toBe(first.head);
    expect(plan.envelope.tx.value).toBe(17n);
    expect(decodeFunctionData({ abi: signedTransmitterAbi, data: plan.envelope.tx.data })).toEqual({
      functionName: "relayAuthority", args: [recipient, first.bytes, []],
    });
    expect(decodeFunctionData({ abi: signedReceiverAbi, data: submitAuthorityBatchCalldata(plan.updates) }).args)
      .toEqual([[first.bytes, second.bytes]]);
    const scaffold = scaffoldAuthorityRelay(plan, {
      producerRepo: "https://github.com/example/ops", sourceRpcEnv: "SOURCE_RPC_URL",
      destinationRpcEnv: "BASE_RPC_URL", safeNetwork: "optimism",
    });
    expect(scaffold.claim).toContain(safeTxHashes(plan.envelope).safeTxHash);
    expect(scaffold.source).toContain(first.bytes.slice(2));
    expect(scaffold.source).not.toContain(second.bytes.slice(2));
    await expect(buildAuthorityRelayBatch([plan, plan], multicall, sourceRpc)).rejects.toThrow("one successor per receiver");
    const anotherReceiver = address(100);
    const other = { ...plan, receiver: anotherReceiver, recipient: encodeEvm(8453n, anotherReceiver) };
    const batch = await buildAuthorityRelayBatch([plan, other], multicall, sourceRpc);
    expect(batch.tx).toMatchObject({ to: multicall, operation: 0, value: 34n });
    const decodedBatch = decodeFunctionData({ abi: aggregate, data: batch.tx.data });
    expect(decodedBatch.functionName).toBe("aggregate3Value");
    expect(decodedBatch.args[0].map(({ allowFailure }) => allowFailure)).toEqual([false, false]);
    const batched = await scaffoldAuthorityRelayBatch([
      { plan, destinationRpcEnv: "BASE_RPC_URL" },
      { plan: other, destinationRpcEnv: "BASE_RPC_URL" },
    ], multicall, sourceRpc, {
      producerRepo: "https://github.com/example/ops", sourceRpcEnv: "SOURCE_RPC_URL", safeNetwork: "optimism",
    });
    expect(batched.safeTxHash).toBe(safeTxHashes(batch).safeTxHash);
    expect(batched.source).toContain("_writeAuthorityRelayBatch");
    submissions.set(first.head, second.bytes);
    await expect(source.submission(safe, first.head)).rejects.toThrow("wrong Safe transaction hash");
  });

  it("builds a parent adoption with the child's forward proof", async () => {
    const childBefore = graphFor(child, owner);
    const childUpdate = published(8n, childBefore, oldHead, child);
    const parentGraph = (position: Hex): AuthorityGraph => ({ nodes: [
      { position: zeroHash, record: { safe, threshold: 1n, owners: [{ owner: child, kind: 1 }] } },
      { position, record: childBefore.nodes[0].record },
    ] });
    const currentGraph = parentGraph(oldHead);
    const parent = published(8n, currentGraph);
    const submissions = new Map([[parent.head, parent.bytes], [childUpdate.head, childUpdate.bytes]]);
    const readContract = vi.fn().mockImplementation(async ({ functionName, args }) => functionName === "selection"
      ? { updateHead: parent.head, authorityHash: authorityGraphHash(chainId, currentGraph) }
      : keccak256(submissions.get(args[1])!));
    const getLogs = vi.fn().mockImplementation(async ({ args }) => [{
      args: { submission: submissions.get(args.updateHead) }, blockNumber: 4n, logIndex: 0,
    }]);
    const source = new AuthoritySource({ readContract, getLogs, getTransaction: vi.fn() },
      chainId, guard, 10n, 0n);
    const proposal = await planAuthorityProposal(source, {
      safe, nonce: 9n, newGraph: parentGraph(childUpdate.head), action: { kind: "select" },
    });
    expect(proposal.childUpdates).toHaveLength(1);
    expect(proposal.childUpdates[0]).toMatchObject({ sourceSafe: child, newRecord: childBefore.nodes[0].record });
  });
  describe("nested child votes", () => {
    const grand = address(20), gPos = toHex(5, { size: 32 });
    const record = (safe: Address, owners: { owner: Address; kind: 0 | 1 }[]) => ({ safe, threshold: 1n, owners });
    const grandRecord = record(grand, [{ owner, kind: 0 }]);
    const childRecord = record(child, [{ owner: grand, kind: 1 }]);
    const childGraph: AuthorityGraph = { nodes: [
      { position: zeroHash, record: childRecord }, { position: gPos, record: grandRecord },
    ] };
    const parentGraph = (childPosition: Hex, childRec: AuthorityGraph["nodes"][number]["record"] = childRecord, withGrand = true): AuthorityGraph => ({ nodes: [
      { position: zeroHash, record: record(safe, [{ owner: child, kind: 1 }]) },
      { position: childPosition, record: childRec },
      ...(withGrand ? [{ position: gPos, record: grandRecord }] : []),
    ] });
    // r = voter, s = offset of the dynamic part, v = 0, then length and bytes.
    const contractVote = (inline: Hex) => concatHex([
      pad(grand, { size: 32 }), toHex(65, { size: 32 }), "0x00", toHex(size(inline), { size: 32 }), inline,
    ]);
    const cachedApproval = (head: Hex): NestedSafeApproval => ({
      childSafe: grand, messageHash: safeMessageHash(chainId, grand, head),
      approval: { safeTx: signedDispatchTx(chainId, grand, guard, 1n, "0x").tx, signatures: signature },
    });

    async function plan(sign: (head: Hex) => Votes, updatedChild = childGraph, parentAfter = (head: Hex) => parentGraph(head)) {
      const update = published(8n, childGraph, oldHead, child, updatedChild, sign);
      const currentGraph = parentGraph(oldHead);
      const parent = published(8n, currentGraph);
      const submissions = new Map([[parent.head, parent.bytes], [update.head, update.bytes]]);
      const readContract = vi.fn().mockImplementation(async ({ functionName, args }) => functionName === "selection"
        ? { updateHead: parent.head, authorityHash: authorityGraphHash(chainId, currentGraph) }
        : keccak256(submissions.get(args[1])!));
      const getLogs = vi.fn().mockImplementation(async ({ args }) => [{
        args: { submission: submissions.get(args.updateHead) }, blockNumber: 4n, logIndex: 0,
      }]);
      const source = new AuthoritySource({ readContract, getLogs, getTransaction: vi.fn() }, chainId, guard, 10n, 0n);
      return planAuthorityProposal(source, { safe, nonce: 9n, newGraph: parentAfter(update.head), action: { kind: "select" } });
    }

    it("proves a nested voter from inline signatures", async () => {
      const proposal = await plan((_) => ({ signatures: contractVote(signature), nestedApprovals: [] }));
      expect(proposal.childUpdates).toHaveLength(1);
      expect(proposal.childUpdates[0].sourceSafe).toBe(child);
    });

    it("proves a nested voter from a cached approval and rejects a missing one", async () => {
      const proposal = await plan((head) => ({ signatures: contractVote("0x"), nestedApprovals: [cachedApproval(head)] }));
      expect(proposal.childUpdates).toHaveLength(1);
      await expect(plan(() => ({ signatures: contractVote("0x"), nestedApprovals: [] })))
        .rejects.toThrow("missing approval");
    });

    it("counts a nested voter only where the voting update's new graph names it", async () => {
      const without: AuthorityGraph = { nodes: [{ position: zeroHash, record: record(child, [{ owner: newOwner, kind: 0 }]) }] };
      await expect(plan(
        () => ({ signatures: contractVote(signature), nestedApprovals: [] }), without,
        (head) => parentGraph(head, without.nodes[0].record, false),
      )).rejects.toThrow("does not name nested voter");
    });

    it("reports children whose own selection moved past the parent's position", async () => {
      const latest = toHex(9, { size: 32 });
      const readContract = vi.fn().mockImplementation(async ({ args }) => ({
        updateHead: args[0] === child ? latest : gPos, authorityHash: zeroHash,
      }));
      const source = new AuthoritySource({ readContract, getLogs: vi.fn(), getTransaction: vi.fn() }, chainId, guard, 10n, 0n);
      await expect(staleAuthorityChildren(source, parentGraph(oldHead))).resolves.toEqual([
        { safe: child, selectedHead: oldHead, latest: { updateHead: latest, authorityHash: zeroHash } },
      ]);
    });
  });

  it("bounds each log search by the newer update and names a receiver that is not an ancestor", async () => {
    const first = published(8n);
    const second = published(9n, graph, first.head);
    const submissions = new Map([[first.head, first.bytes], [second.head, second.bytes]]);
    const readContract = vi.fn().mockImplementation(async ({ args }) =>
      submissions.has(args[1]) ? keccak256(submissions.get(args[1])!) : zeroHash);
    const getLogs = vi.fn().mockImplementation(async ({ args }) => [{
      args: { submission: submissions.get(args.updateHead) }, blockNumber: args.updateHead === second.head ? 7n : 4n, logIndex: 0,
    }]);
    const source = new AuthoritySource({ readContract, getLogs, getTransaction: vi.fn() }, chainId, guard, 10n, 0n);
    await expect(source.successors(safe, oldHead, second.head)).resolves.toHaveLength(2);
    expect(getLogs.mock.calls.map(([{ toBlock }]) => toBlock)).toEqual([10n, 7n]);
    await expect(source.successors(safe, toHex(77, { size: 32 }), second.head)).rejects.toThrow("not an ancestor");
  });

  it("accepts owner mutations in any hex case", () => {
    const swap = encodeFunctionData({ abi: mutations, functionName: "swapOwner", args: [address(1), owner, newOwner] });
    const input = (data: Hex) => ({
      ...base, selection, currentGraph: graph, newGraph: graphFor(safe, newOwner),
      action: { kind: "ownership" as const, multiSend: multicall, mutations: [data] },
    });
    const upper = `0x${swap.slice(2).toUpperCase()}` as Hex;
    expect(buildAuthorityProposal(input(upper)).envelope.tx.data).toBe(buildAuthorityProposal(input(swap)).envelope.tx.data);
  });

  describe("Solidity relay vectors", () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../vectors/${name}.json`, import.meta.url), "utf8"));
    const update = (submission: Hex) => ({ bytes: submission }) as never;

    it("derives the single relay's Safe transaction hash", async () => {
      const v = read("authority-relay-single");
      const readContract = vi.fn().mockResolvedValue(BigInt(v.fee));
      const envelope = await buildAuthorityRelayProposal({
        rpc: { readContract }, chainId: BigInt(v.chainId), safe: v.safe, nonce: BigInt(v.nonce), transmitter: v.transmitter,
        recipient: v.recipient, attributes: [v.attribute], update: update(v.submission), blockNumber: 1n,
      });
      expect(safeTxHashes(envelope).safeTxHash).toBe(v.safeTxHash);
      expect(readContract.mock.calls[0][0].account).toBe(v.safe);
    });

    it("derives the batch relay's Safe transaction hash, quoting as the multicall", async () => {
      const v = read("authority-relay-batch");
      const fees = new Map<string, bigint>(v.transmitters.map((t: string, i: number) => [t, BigInt(v.fees[i])]));
      const readContract = vi.fn().mockImplementation(async ({ address, account }) => {
        if (account !== v.multicall) throw new Error("quote must come from the multicall");
        return fees.get(address)!;
      });
      const plans = v.transmitters.map((transmitter: Address, i: number) => ({
        envelope: signedDispatchTx(BigInt(v.chainId), v.safe, transmitter, BigInt(v.nonce), "0x"), sourceBlock: 1n,
        destinationChainId: BigInt(i + 1), receiver: address(100 + i), recipient: v.recipient, attributes: [v.attribute],
        update: update(v.submission),
      })) as unknown as AuthorityRelayPlan[];
      const batch = await buildAuthorityRelayBatch(plans, v.multicall, { readContract });
      expect(safeTxHashes(batch).safeTxHash).toBe(v.safeTxHash);
    });
  });
});
