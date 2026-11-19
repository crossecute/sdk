import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Hex, decodeFunctionData } from "viem";
import * as s from "../src/signed.js";
import * as m from "../src/merkle.js";
import { crossecuteGuardAbi } from "../src/signedAbi.js";

const vectors = JSON.parse(readFileSync(new URL("../../vectors/merkle.json", import.meta.url), "utf8"));

const GUARD_DESTINATION: Hex = "0x000100000114";
const guardLeaves = (count: number): m.MerkleLeaf[] =>
  Array.from({ length: count }, (_, i) => ({
    kind: "execution" as const,
    leaf: { destination: GUARD_DESTINATION, nonce: BigInt(i), validAfter: 0n, deadline: 1000n, calls: "0xc0de" as Hex, attributes: ["0xaa"] as Hex[] },
  }));
const exec = (destination: Hex, nonce: bigint, calls: Hex): m.MerkleLeaf => ({
  kind: "execution", leaf: { destination, nonce, validAfter: 10n, deadline: 20n, calls, attributes: [] },
});
const mixedLeaves: m.MerkleLeaf[] = [
  exec("0x0001000001aa", 3n, "0x01"),
  exec("0x0001000001bb", 0n, "0x02"),
  exec("0x0001000001aa", 4n, "0x03"),
  { kind: "bootstrap", leaf: { destination: "0x0001000001cc", validAfter: 10n, deadline: 20n, setupCalls: "0x04" } },
];
const mixedNonces: m.ReceiverNonce[] = [
  { destination: "0x0001000001aa", nextNonce: 3n },
  { destination: "0x0001000001bb", nextNonce: 0n },
];
const nonces = (): m.ReceiverNonce[] => [{ destination: GUARD_DESTINATION, nextNonce: 0n }];

describe("package parity with the Solidity reference", () => {
  const cases: [string, m.MerkleLeaf[], m.ReceiverNonce[]][] = [
    ...[1, 2, 3, 5, 8, 9].map((n): [string, m.MerkleLeaf[], m.ReceiverNonce[]] => [`guard${n}`, guardLeaves(n), nonces()]),
    ["mixed", mixedLeaves, mixedNonces],
  ];
  for (const [name, leaves, receiverNonces] of cases) {
    it(name, () => {
      const v = vectors[name];
      const pkg = m.buildMerklePackage(leaves, receiverNonces);
      expect(pkg.leaves.map(m.encodeMerkleLeaf)).toEqual(v.leaves);
      expect(pkg.root).toBe(v.root);
      expect(pkg.leaves.map((e) => e.hash)).toEqual(v.hashes);
      pkg.leaves.forEach((e, i) => expect(e.proof).toEqual(v[`proof${i}`]));
      m.verifyMerklePackage(pkg);
    });
  }

  it("matches the guard's cast-computed odd-tree root and indexed leaf hashes", () => {
    const pkg = m.buildMerklePackage(guardLeaves(3), nonces());
    expect(pkg.root).toBe("0xaa82123f67075907e439bf4fe2b85cf4d0ab12f4d94de47506e1f6f835034819");
    expect(pkg.leaves.map((e) => e.hash)).toEqual([
      "0xbb78bf94c5e1c6f91b744da93971ac6777fc646ca26ab0005ef1e624277d7070",
      "0x19cc3775f22e8e5247aee60d5789fc9dc2011767e187f9c8872263cb6a7edca3",
      "0xf0bba0d846d5b46c2343ec2bf330ed19c35e1c41a202ad1c991c01b7a2f840b9",
    ]);
  });

  it("publishes the ordered encoded leaves the guard roots", () => {
    const pkg = m.buildMerklePackage(guardLeaves(3), nonces());
    const { functionName, args } = decodeFunctionData({ abi: crossecuteGuardAbi, data: m.merklePublishData(pkg) });
    expect(functionName).toBe("publishLeaves");
    expect(args![0]).toEqual(pkg.leaves.map(m.encodeMerkleLeaf));
  });
});

describe("local nonce plans", () => {
  const build = (leaves: m.MerkleLeaf[], n = nonces()) => m.buildMerklePackage(leaves, n);
  it("rejects two batches at one receiver nonce", () => {
    const [a] = guardLeaves(1);
    const other: m.MerkleLeaf = { kind: "execution", leaf: { ...(a as { leaf: s.ExecutionLeaf }).leaf, calls: "0xbeef" } };
    expect(() => build([a, other])).toThrow("conflicting nonce");
  });
  it("allows one batch at one nonce with different attributes, and rejects the identical leaf twice", () => {
    const [a] = guardLeaves(1) as { kind: "execution"; leaf: s.ExecutionLeaf }[];
    const retargeted: m.MerkleLeaf = { kind: "execution", leaf: { ...a.leaf, attributes: ["0xbb"] } };
    expect(build([a, retargeted]).leaves).toHaveLength(2);
    expect(() => build([a, a])).toThrow("duplicate leaf");
  });
  it("allows the same nonce on different receivers", () => {
    const pkg = build([exec("0x0001000001aa", 0n, "0x01"), exec("0x0001000001bb", 0n, "0x01")], [
      { destination: "0x0001000001aa", nextNonce: 0n }, { destination: "0x0001000001bb", nextNonce: 0n },
    ]);
    expect(pkg.leaves).toHaveLength(2);
  });
  it("rejects a nonce below the observed nextNonce", () => {
    expect(() => build(guardLeaves(2), [{ destination: GUARD_DESTINATION, nextNonce: 1n }])).toThrow("stale nonce");
  });
  it("requires exactly the observed receivers", () => {
    expect(() => build(guardLeaves(1), [])).toThrow("missing receiver nonce");
    expect(() => build(guardLeaves(1), [...nonces(), { destination: "0x0001000001aa", nextNonce: 0n }])).toThrow("receiver nonce without a leaf");
    expect(() => build(guardLeaves(1), [...nonces(), ...nonces()])).toThrow("duplicate receiver nonce");
    expect(() => build(guardLeaves(1), [{ destination: GUARD_DESTINATION, nextNonce: -1n }])).toThrow("invalid receiver nonce");
  });
  it("needs a leaf, and bootstrap leaves need no receiver nonce", () => {
    expect(() => build([])).toThrow("no leaves");
    const boot = mixedLeaves[3];
    expect(build([boot], []).leaves).toHaveLength(1);
  });
  it("matches receivers regardless of destination hex case", () => {
    expect(build(guardLeaves(1), [{ destination: "0x000100000114".toUpperCase().replace("0X", "0x") as Hex, nextNonce: 0n }]).leaves).toHaveLength(1);
  });
});

describe("package JSON", () => {
  const pkg = () => m.buildMerklePackage(mixedLeaves, mixedNonces);
  it("round trips with bigints as decimal strings", () => {
    const json = m.serializeMerklePackage(pkg());
    expect(JSON.parse(json).receiverNonces[0].nextNonce).toBe("3");
    expect(m.parseMerklePackage(json)).toEqual(pkg());
  });
  it("detects a tampered root, hash, proof or leaf", () => {
    const edit = (f: (o: any) => void) => { const o = JSON.parse(m.serializeMerklePackage(pkg())); f(o); return JSON.stringify(o); };
    const word = (n: string) => `0x${n.repeat(64)}`;
    expect(() => m.parseMerklePackage(edit((o) => { o.root = word("1"); }))).toThrow("root mismatch");
    expect(() => m.parseMerklePackage(edit((o) => { o.leaves[1].hash = word("1"); }))).toThrow("leaf hash mismatch at 1");
    expect(() => m.parseMerklePackage(edit((o) => { o.leaves[0].proof.reverse(); }))).toThrow("proof mismatch at 0");
    expect(() => m.parseMerklePackage(edit((o) => { o.leaves[2].calls = "0x0303"; }))).toThrow("mismatch");
    expect(() => m.parseMerklePackage(edit((o) => { [o.leaves[0], o.leaves[2]] = [o.leaves[2], o.leaves[0]]; }))).toThrow("mismatch");
  });
  it("rejects unknown versions, extra fields and malformed values", () => {
    const edit = (f: (o: any) => void) => { const o = JSON.parse(m.serializeMerklePackage(pkg())); f(o); return JSON.stringify(o); };
    expect(() => m.parseMerklePackage(edit((o) => { o.version = 2; }))).toThrow("unsupported Merkle package version");
    expect(() => m.parseMerklePackage(edit((o) => { o.extra = 1; }))).toThrow("fields must be exactly");
    expect(() => m.parseMerklePackage(edit((o) => { o.leaves[0].nonce = "0x3"; }))).toThrow("not a decimal string");
    expect(() => m.parseMerklePackage(edit((o) => { o.leaves[0].kind = "other"; }))).toThrow("not execution or bootstrap");
    expect(() => m.parseMerklePackage(edit((o) => { o.leaves[0].proof = ["0x12"]; }))).toThrow("32-byte hex word");
  });
});
