import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Address, type Hex, decodeFunctionData, padHex, toHex } from "viem";
import * as s from "../src/signed.js";
import { safeTxHashes, serializeSafeTxTypedData, parseSafeTxTypedData } from "../src/safeTx.js";
import { safeBatchExecutorAbi, signedTransmitterAbi } from "../src/signedAbi.js";

const vectors = JSON.parse(readFileSync(new URL("../../vectors/signed.json", import.meta.url), "utf8"));
const addr = (n: number) => padHex(toHex(n), { size: 20 }) as Address;
const word = (n: number) => padHex(toHex(n), { size: 32 });
const leaf: s.ExecutionLeaf = { destination: "0x00010000010a141111111111111111111111111111111111111111", nonce: 7n, validAfter: 100n, deadline: 200n, calls: "0xabcdef", attributes: ["0x1234"] };
const boot: s.BootstrapLeaf = { destination: leaf.destination, validAfter: 100n, deadline: 200n, setupCalls: "0x12345678" };
const envelope = s.signedDispatchTx(1n, addr(0x7777), addr(0x2222), 42n, "0xabcdef", 3n);
const evidence: s.SafeTxEvidence = {
  signedSafeTx: { safeTx: envelope.tx, signatures: "0x123456" },
  nestedApprovals: [{ childSafe: addr(0x3333), messageHash: word(5), approval: { safeTx: s.signedDispatchTx(1n, addr(0x3333), addr(0x4444), 2n, "0x7788").tx, signatures: "0xaabb" } }],
};
const records: s.SafeAuthorityRecord[] = [
  { safe: addr(0x7777), threshold: 2n, owners: [{ owner: addr(0x5555), kind: 0 }, { owner: addr(0x3333), kind: 1 }] },
  { safe: addr(0x3333), threshold: 1n, owners: [{ owner: addr(0x6666), kind: 0 }] },
];
const fields = [s.encodeExecutionLeaf(leaf), s.encodeBootstrapLeaf(boot), "0xaabbcc"] as Hex[];

describe("protocol #135 Solidity parity", () => {
  const checks: Record<string, () => Hex> = {
    executionFields: () => s.encodeExecutionLeaf(leaf), executionHash: () => s.executionLeafHash(leaf),
    executionId: () => s.executionId(leaf), bootstrapFields: () => s.encodeBootstrapLeaf(boot),
    bootstrapHash: () => s.bootstrapLeafHash(boot),
    bootstrapData: () => s.signedBootstrapData(s.bootstrapLeafHash(boot), boot, [], leaf.attributes),
    sendData: () => s.signedSendData(leaf.destination, leaf.calls, leaf.attributes),
    standaloneWire: () => s.encodeStandaloneWire(evidence), merkleWire: () => s.encodeMerkleWire(evidence, leaf, []),
    bootstrapBody: () => s.encodeSignedBootstrap({ evidence, records }), registerData: () => s.registerRootData(s.bootstrapLeafHash(boot)),
    relayData: () => s.relayLeafData(evidence, leaf, []), submitMessageData: () => s.submitMessageData(evidence),
    submitLeafData: () => s.submitLeafData(evidence, leaf, []), graphHash: () => s.authorityGraphHash(records),
    signedSalt: () => s.signedConduitSalt(addr(0x7777), word(1), word(2), s.authorityGraphHash(records)),
    safeMessageHash: () => s.safeMessageHash(1n, addr(0x3333), "0xabcdef"), safeTxHash: () => safeTxHashes(envelope).safeTxHash,
    publishData: () => s.publishLeavesData(fields), oddRoot: () => s.dispatchTree(fields).root,
    safeBatchData: () => s.safeBatchData([{ envelope, signatures: evidence.signedSafeTx.signatures }]),
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
  it("rejects empty publication and wrong bootstrap proof", () => {
    expect(() => s.dispatchTree([])).toThrow("no leaves");
    expect(() => s.publishLeavesData([])).toThrow("no leaves");
    expect(() => s.signedBootstrapData(word(0), boot, [], [])).toThrow("invalid bootstrap proof");
    expect(() => s.signedSendData(leaf.destination, "0x", [])).toThrow("empty signed payload");
  });
});

describe("creation authority and source signing", () => {
  it("accepts canonical nested and shared Safe graphs", () => {
    s.validateAuthorityRecords(records, addr(0x7777));
    const shared = [...records, { safe: addr(0x8888), threshold: 1n, owners: [{ owner: addr(0x3333), kind: 1 as const }] }];
    shared[0] = { ...shared[0], owners: [...shared[0].owners, { owner: addr(0x8888), kind: 1 }] };
    s.validateAuthorityRecords(shared, addr(0x7777));
  });
  it("rejects cycles, unreachable, duplicate, missing and reordered records", () => {
    for (const bad of [[], [...records, records[1]], [records[1], records[0]], [records[0]],
      [...records, { ...records[1], safe: addr(0x8888) }],
      [records[0], { ...records[1], owners: [{ owner: addr(0x7777), kind: 1 as const }] }],
      [{ ...records[0], threshold: 0n }, records[1]],
      [{ ...records[0], owners: [{ owner: addr(1), kind: 0 as const }] }, records[1]],
      [{ ...records[0], owners: [{ owner: addr(0x3333), kind: 0 as const }] }, records[1]],
    ]) expect(() => s.validateAuthorityRecords(bad, addr(0x7777))).toThrow();
  });
  it("round trips signed typed data for Forge Attest without losing nonce precision", () => {
    const e = { ...envelope, tx: { ...envelope.tx, nonce: 2n ** 200n } };
    expect(parseSafeTxTypedData(serializeSafeTxTypedData(e))).toEqual(e);
  });
  it("uses the child domain for nested approvals", () => {
    expect(s.safeMessageHash(1n, addr(0x3333), "0xabcdef")).not.toBe(s.safeMessageHash(1n, addr(0x7777), "0xabcdef"));
    expect(s.safeMessageHash(1n, addr(0x3333), "0xabcdef")).not.toBe(s.safeMessageHash(10n, addr(0x3333), "0xabcdef"));
  });
  it("builds separate CALLs and an atomic batch at consecutive Safe nonces", () => {
    const a = s.signedDispatchTx(1n, envelope.safe, envelope.tx.to, 42n, s.signedSendData(leaf.destination, leaf.calls, []));
    const b = s.signedDispatchTx(1n, envelope.safe, envelope.tx.to, 43n, s.registerRootData(word(1)));
    expect(a.tx.operation).toBe(0);
    expect(a.tx.safeTxGas).toBe(0n);
    expect(decodeFunctionData({ abi: signedTransmitterAbi, data: a.tx.data }).functionName).toBe("sendMessage");
    const data = s.safeBatchData([{ envelope: a, signatures: "0x" }, { envelope: b, signatures: "0x" }]);
    expect(decodeFunctionData({ abi: safeBatchExecutorAbi, data }).args[0]).toHaveLength(2);
    expect(() => s.signedDispatchTx(0n, envelope.safe, envelope.tx.to, 0n, "0x")).toThrow("invalid source chain");
    expect(() => s.signedDispatchTx(1n, envelope.safe, envelope.tx.to, -1n, "0x")).toThrow("invalid Safe nonce");
    expect(() => s.safeBatchData([{ envelope: b, signatures: "0x" }, { envelope: a, signatures: "0x" }])).toThrow("nonconsecutive");
    expect(() => s.safeBatchData([{ envelope: a, signatures: "0x" }, { envelope: { ...b, chainId: 10n }, signatures: "0x" }])).toThrow("mixed source chains");
  });
});
