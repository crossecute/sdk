import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Address, type Hex, decodeAbiParameters, decodeFunctionData, padHex, toHex, zeroHash } from "viem";
import { encodeBootstrap, encodeCalls } from "../src/encoding.js";
import * as s from "../src/signed.js";
import { safeTxHashes, serializeSafeTxTypedData, parseSafeTxTypedData } from "../src/safeTx.js";
import { safeBatchExecutorAbi, signedTransmitterAbi } from "../src/signedAbi.js";

const vectors = JSON.parse(readFileSync(new URL("../../vectors/signed.json", import.meta.url), "utf8"));
const addr = (n: number) => padHex(toHex(n), { size: 20 }) as Address;
const word = (n: number) => padHex(toHex(n), { size: 32 });
const leaf: s.ExecutionLeaf = { destination: "0x00010000010a141111111111111111111111111111111111111111", nonce: 7n, validAfter: 100n, deadline: 200n, calls: "0xabcdef", attributes: ["0x1234"] };
const OWNER = addr(0x7777), GUARD = addr(0x4444), HEAD = word(0xfeed), BOOTSTRAP_DESTINATION: Hex = "0x00010000010a00";
const graph: s.AuthorityGraph = {
  nodes: [
    { record: { safe: addr(0x7777), threshold: 2n, owners: [{ owner: addr(0x5555), kind: 0 }, { owner: addr(0x3333), kind: 1 }] }, position: zeroHash },
    { record: { safe: addr(0x3333), threshold: 1n, owners: [{ owner: addr(0x6666), kind: 0 }] }, position: word(9) },
  ],
};
const bootstrap: s.SignedBootstrap = { guard: GUARD, updateHead: HEAD, authority: graph, setupCalls: encodeCalls([]) };
const envelope = s.signedDispatchTx(1n, addr(0x7777), addr(0x2222), 42n, "0xabcdef", 3n);
const evidence: s.SafeTxEvidence = {
  signedSafeTx: { safeTx: envelope.tx, signatures: "0x123456" },
  nestedApprovals: [{ childSafe: addr(0x3333), messageHash: word(5), approval: { safeTx: s.signedDispatchTx(1n, addr(0x3333), addr(0x4444), 2n, "0x7788").tx, signatures: "0xaabb" } }],
};
const second: s.ExecutionLeaf = { ...leaf, nonce: 8n, calls: "0x010203" };
const fields = [s.encodeExecutionLeaf(leaf), s.encodeExecutionLeaf(second), "0xaabbcc"] as Hex[];

describe("signed dispatch Solidity parity", () => {
  const checks: Record<string, () => Hex> = {
    executionFields: () => s.encodeExecutionLeaf(leaf), executionHash: () => s.executionLeafHash(leaf),
    executionId: () => s.executionId(leaf), authorityGraph: () => s.encodeAuthorityGraph(graph),
    bootstrapBody: () => s.encodeBootstrapBodySigned(bootstrap, OWNER),
    bootstrapData: () => s.bootstrapCalldataSigned(BOOTSTRAP_DESTINATION, bootstrap, OWNER, leaf.attributes),
    sendData: () => s.sendMessageCalldataSigned(leaf.destination, leaf.calls, leaf.attributes),
    standaloneWire: () => s.encodeStandaloneWire(evidence), merkleWire: () => s.encodeMerkleWire(evidence, leaf, []),
    registerData: () => s.registerRootCalldata(s.executionLeafHash(leaf)),
    relayData: () => s.relayLeafCalldata(evidence, leaf, []), submitMessageData: () => s.submitMessageCalldata(evidence),
    submitLeafData: () => s.submitLeafCalldata(evidence, leaf, []),
    safeMessageHash: () => s.safeMessageHash(1n, addr(0x3333), "0xabcdef"), safeTxHash: () => safeTxHashes(envelope).safeTxHash,
    publishData: () => s.publishLeavesCalldata(fields), oddRoot: () => s.dispatchTree(fields).root,
    safeBatchData: () => s.safeBatchCalldata([{ envelope, signatures: evidence.signedSafeTx.signatures }]),
  };
  for (const [name, fn] of Object.entries(checks)) it(name, () => expect(fn()).toBe(vectors[name]));
});

describe("Merkle publication and replay", () => {
  for (const count of [1, 2, 3, 5, 7, 8, 9, 17]) it(`proofs for ${count} leaves`, () => {
    const tree = s.dispatchTree(Array.from({ length: count }, (_, i) => toHex(i, { size: 4 })));
    tree.hashes.forEach((hash, i) => expect(s.verifyDispatchProof(hash, tree.proofs[i], tree.root)).toBe(true));
    expect(s.verifyDispatchProof(word(0), tree.proofs[0], tree.root)).toBe(false);
  });
  it("does not sort leaves, pad odd levels, or add a singleton proof", () => {
    const tree = s.dispatchTree(fields);
    expect(tree.proofs[2]).toHaveLength(1);
    expect(s.dispatchTree([fields[0]]).proofs).toEqual([[]]);
    expect(s.dispatchTree([...fields].reverse()).root).not.toBe(tree.root);
  });
  it("commits attributes to proof but excludes them from replay identity", () => {
    const changed = { ...leaf, attributes: ["0x5678"] as Hex[] };
    expect(s.executionLeafHash(changed)).not.toBe(s.executionLeafHash(leaf));
    expect(s.executionId(changed)).toBe(s.executionId(leaf));
    for (const changed of [{ ...leaf, nonce: 8n }, { ...leaf, calls: "0x1122" as Hex }, { ...leaf, deadline: 201n }]) {
      expect(s.executionId(changed)).not.toBe(s.executionId(leaf));
    }
  });
  it("rejects empty publication and empty send", () => {
    expect(() => s.dispatchTree([])).toThrow("no leaves");
    expect(() => s.publishLeavesCalldata([])).toThrow("no leaves");
    expect(() => s.sendMessageCalldataSigned(leaf.destination, "0x", [])).toThrow("empty signed payload");
  });
});

describe("signed bootstrap", () => {
  it("decodes to the guard, head, encoded graph and setup calls", () => {
    const [decoded] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "guard", type: "address" }, { name: "updateHead", type: "bytes32" }, { name: "authority", type: "bytes" }, { name: "setupCalls", type: "bytes" }] }],
      s.encodeBootstrapBodySigned(bootstrap, OWNER),
    );
    expect(decoded).toEqual({ guard: GUARD, updateHead: HEAD, authority: s.encodeAuthorityGraph(graph), setupCalls: encodeCalls([]) });
  });
  it("wraps the body in the destination payload of bootstrap(payload, attributes)", () => {
    const { functionName, args } = decodeFunctionData({ abi: signedTransmitterAbi, data: s.bootstrapCalldataSigned(BOOTSTRAP_DESTINATION, bootstrap, OWNER, ["0xaa"]) });
    expect(functionName).toBe("bootstrap");
    expect(args).toEqual([encodeBootstrap(BOOTSTRAP_DESTINATION, s.encodeBootstrapBodySigned(bootstrap, OWNER)), ["0xaa"]]);
  });
  it("refuses a zero head and an invalid graph before encoding", () => {
    expect(() => s.encodeBootstrapBodySigned({ ...bootstrap, updateHead: zeroHash }, OWNER)).toThrow("zero update head");
    expect(() => s.encodeBootstrapBodySigned({ ...bootstrap, authority: { nodes: [] } }, OWNER)).toThrow("wrong authority root");
    expect(() => s.encodeBootstrapBodySigned({ ...bootstrap, authority: { nodes: [graph.nodes[0]] } }, OWNER)).toThrow("missing authority record");
  });
  it("refuses a graph rooted at a Safe other than the owner", () => {
    const other = addr(0x9999);
    expect(() => s.encodeBootstrapBodySigned(bootstrap, other)).toThrow("wrong authority root");
    expect(() => s.bootstrapCalldataSigned(BOOTSTRAP_DESTINATION, bootstrap, other, [])).toThrow("wrong authority root");
    // A graph that is canonical for its own root still fails for the owner.
    const rerooted = { nodes: [{ ...graph.nodes[1], position: zeroHash }] };
    s.requireAuthorityGraph(rerooted, addr(0x3333));
    expect(() => s.encodeBootstrapBodySigned({ ...bootstrap, authority: rerooted }, OWNER)).toThrow("wrong authority root");
    expect(() => s.encodeBootstrapBodySigned({ ...bootstrap, authority: rerooted }, addr(0x3333))).not.toThrow();
  });
});

describe("protocol #109 authority vectors", () => {
  const authority = JSON.parse(readFileSync(new URL("../../vectors/authority.json", import.meta.url), "utf8"));
  for (const key of ["single", "shared"]) {
    it(`${authority[key].id}: graph hash, record hashes, graph and bootstrap bytes`, () => {
      const v = authority[key];
      const nodes: s.AuthorityNode[] = v.graph.nodes.map((n: any) => ({
        record: { safe: n.record.safe, threshold: BigInt(n.record.threshold), owners: n.record.owners.map((o: any) => ({ owner: o.owner, kind: o.kind })) },
        position: n.position,
      }));
      const g = { nodes };
      s.requireAuthorityGraph(g, v.sourceSafe);
      expect(nodes.map((n) => s.authorityRecordHash(n.record))).toEqual(v.graph.entries.map((e: any) => e.recordHash));
      expect(s.authorityGraphHash(BigInt(v.sourceChainId), g)).toBe(v.graph.graphHash);
      expect(s.encodeBootstrapBodySigned({ guard: v.guard, updateHead: v.updateHead, authority: g, setupCalls: encodeCalls([]) }, v.sourceSafe)).toBe(v.encoded);
    });
  }
  it("commits to the source chain, each record and each position", () => {
    const base = s.authorityGraphHash(1n, graph);
    expect(s.authorityGraphHash(10n, graph)).not.toBe(base);
    expect(s.authorityGraphHash(1n, { nodes: [graph.nodes[0], { ...graph.nodes[1], position: word(10) }] })).not.toBe(base);
    expect(s.authorityGraphHash(1n, { nodes: [{ ...graph.nodes[0], record: { ...graph.nodes[0].record, threshold: 1n } }, graph.nodes[1]] })).not.toBe(base);
  });
});

describe("selected authority graph validation", () => {
  const root = addr(0x7777);
  const [rootNode, childNode] = graph.nodes;
  const owners = (n: number, start = 0x100) => Array.from({ length: n }, (_, i) => ({ owner: addr(start + i), kind: 0 as const }));
  it("accepts canonical nested and shared Safe graphs", () => {
    s.requireAuthorityGraph(graph, root);
    const shared: s.AuthorityGraph = { nodes: [
      { ...rootNode, record: { ...rootNode.record, owners: [...rootNode.record.owners, { owner: addr(0x8888), kind: 1 }] } },
      childNode,
      { record: { safe: addr(0x8888), threshold: 1n, owners: [{ owner: addr(0x3333), kind: 1 }] }, position: word(11) },
    ] };
    s.requireAuthorityGraph(shared, root);
  });
  it("rejects cycles, unreachable, duplicate, missing and reordered nodes", () => {
    const extra = { record: { ...childNode.record, safe: addr(0x8888) }, position: word(11) };
    for (const nodes of [[], [rootNode, childNode, childNode], [childNode, rootNode], [rootNode], [rootNode, childNode, extra],
      [rootNode, { ...childNode, record: { ...childNode.record, owners: [{ owner: root, kind: 1 as const }] } }],
    ]) expect(() => s.requireAuthorityGraph({ nodes }, root)).toThrow();
  });
  it("rejects invalid thresholds, owners and kinds", () => {
    const withRoot = (record: s.SafeAuthorityRecord): s.AuthorityGraph => ({ nodes: [{ record, position: zeroHash }] });
    for (const record of [
      { ...rootNode.record, threshold: 0n, owners: owners(2) }, { ...rootNode.record, threshold: 3n, owners: owners(2) },
      { ...rootNode.record, threshold: 1n, owners: [{ owner: addr(1), kind: 0 as const }] },
      { ...rootNode.record, threshold: 1n, owners: [{ owner: addr(0), kind: 0 as const }] },
      { ...rootNode.record, threshold: 1n, owners: [{ owner: root, kind: 0 as const }] },
      { ...rootNode.record, threshold: 1n, owners: [...owners(1), ...owners(1)] },
      { ...rootNode.record, threshold: 1n, owners: [{ owner: addr(0x100), kind: 2 as 0 }] },
    ]) expect(() => s.requireAuthorityGraph(withRoot(record), root)).toThrow();
    const eoaWithRecord = { ...rootNode, record: { ...rootNode.record, threshold: 1n, owners: [{ owner: addr(0x3333), kind: 0 as const }] } };
    expect(() => s.requireAuthorityGraph({ nodes: [eoaWithRecord, childNode] }, root)).toThrow("invalid owner kind");
  });
  it("caps immediate owners at 16", () => {
    const withOwners = (n: number): s.AuthorityGraph => ({ nodes: [{ record: { safe: root, threshold: 1n, owners: owners(n) }, position: zeroHash }] });
    expect(() => s.requireAuthorityGraph(withOwners(s.MAX_SAFE_OWNERS), root)).not.toThrow();
    expect(() => s.requireAuthorityGraph(withOwners(s.MAX_SAFE_OWNERS + 1), root)).toThrow("too many owners");
  });
  it("requires the owner Safe as root at position zero and nonzero descendant positions", () => {
    expect(() => s.requireAuthorityGraph(graph, addr(0x9999))).toThrow("wrong authority root");
    expect(() => s.requireAuthorityGraph({ nodes: [{ ...rootNode, position: word(1) }, childNode] }, root)).toThrow("root position not zero");
    expect(() => s.requireAuthorityGraph({ nodes: [rootNode, { ...childNode, position: zeroHash }] }, root)).toThrow("unproven descendant position");
  });
});

describe("source signing", () => {
  it("round trips signed typed data for Forge Attest without losing nonce precision", () => {
    const e = { ...envelope, tx: { ...envelope.tx, nonce: 2n ** 200n } };
    expect(parseSafeTxTypedData(serializeSafeTxTypedData(e))).toEqual(e);
  });
  it("uses the child domain for nested approvals", () => {
    expect(s.safeMessageHash(1n, addr(0x3333), "0xabcdef")).not.toBe(s.safeMessageHash(1n, addr(0x7777), "0xabcdef"));
    expect(s.safeMessageHash(1n, addr(0x3333), "0xabcdef")).not.toBe(s.safeMessageHash(10n, addr(0x3333), "0xabcdef"));
  });
  it("builds separate CALLs and an atomic batch at consecutive Safe nonces", () => {
    const a = s.signedDispatchTx(1n, envelope.safe, envelope.tx.to, 42n, s.sendMessageCalldataSigned(leaf.destination, leaf.calls, []));
    const b = s.signedDispatchTx(1n, envelope.safe, envelope.tx.to, 43n, s.registerRootCalldata(word(1)));
    expect(a.tx.operation).toBe(0);
    expect(a.tx.safeTxGas).toBe(0n);
    expect(decodeFunctionData({ abi: signedTransmitterAbi, data: a.tx.data }).functionName).toBe("sendMessage");
    const data = s.safeBatchCalldata([{ envelope: a, signatures: "0x" }, { envelope: b, signatures: "0x" }]);
    expect(decodeFunctionData({ abi: safeBatchExecutorAbi, data }).args[0]).toHaveLength(2);
    expect(() => s.signedDispatchTx(0n, envelope.safe, envelope.tx.to, 0n, "0x")).toThrow("invalid source chain");
    expect(() => s.signedDispatchTx(1n, envelope.safe, envelope.tx.to, -1n, "0x")).toThrow("invalid Safe nonce");
    expect(() => s.safeBatchCalldata([{ envelope: b, signatures: "0x" }, { envelope: a, signatures: "0x" }])).toThrow("nonconsecutive");
    expect(() => s.safeBatchCalldata([{ envelope: a, signatures: "0x" }, { envelope: { ...b, chainId: 10n }, signatures: "0x" }])).toThrow("mixed source chains");
  });
});
