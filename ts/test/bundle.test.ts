import { describe, expect, it } from "vitest";
import { type Address, type Hex, encodeFunctionData, padHex, toHex } from "viem";
import * as s from "../src/signed.js";
import * as m from "../src/merkle.js";
import * as b from "../src/bundle.js";
import { safeTxHashes } from "../src/safeTx.js";
import { signedTransmitterAbi } from "../src/signedAbi.js";

const addr = (n: number) => padHex(toHex(n), { size: 20 }) as Address;
const word = (n: number) => padHex(toHex(n), { size: 32 });
const SAFE = addr(0x7777), TRANSMITTER = addr(0x2222), DESTINATION: Hex = "0x000100000114";
const nested: s.NestedSafeApproval = {
  childSafe: addr(0x3333), messageHash: word(5),
  approval: { safeTx: s.signedDispatchTx(1n, addr(0x3333), addr(0x4444), 2n, "0x7788").tx, signatures: "0xaabb" },
};
const leaves: s.ExecutionLeaf[] = [0n, 1n, 2n].map((nonce) => (
  { destination: DESTINATION, nonce, validAfter: 0n, deadline: 1000n, calls: "0xc0de", attributes: ["0xaa"] }
));
const pkg = () => m.buildMerklePackage(leaves, [{ destination: DESTINATION, nextNonce: 0n }]);
const standalone = () => b.buildDeliveryBundle({
  envelope: s.signedDispatchTx(1n, SAFE, TRANSMITTER, 42n, s.signedSendData(DESTINATION, "0xc0de", ["0xaa"]), 3n),
  signatures: "0x123456", nestedApprovals: [nested],
});
const merkle = () => b.buildDeliveryBundle({
  envelope: s.signedDispatchTx(1n, SAFE, TRANSMITTER, 43n, s.registerRootData(pkg().root)), signatures: "0x123456", merkle: pkg(),
});
const edit = (bundle: b.DeliveryBundle, f: (o: any) => void) => { const o = JSON.parse(b.serializeDeliveryBundle(bundle)); f(o); return JSON.stringify(o); };

describe("delivery bundle round trip", () => {
  it("restores a standalone bundle exactly", () => {
    const bundle = standalone();
    const json = b.serializeDeliveryBundle(bundle);
    expect(JSON.parse(json)).toMatchObject({ version: 1, safe: SAFE, homeChainId: "1", merkle: null });
    expect(b.parseDeliveryBundle(json)).toEqual(bundle);
    expect(bundle.safeTxHash).toBe(safeTxHashes({ chainId: 1n, safe: SAFE, tx: bundle.evidence.signedSafeTx.safeTx }).safeTxHash);
  });
  it("restores a Merkle bundle with its package", () => {
    const bundle = merkle();
    expect(b.parseDeliveryBundle(b.serializeDeliveryBundle(bundle))).toEqual(bundle);
  });
  it("keeps nonces beyond 2^53 exact", () => {
    const e = s.signedDispatchTx(1n, SAFE, TRANSMITTER, 2n ** 200n, s.signedSendData(DESTINATION, "0xc0de", []));
    const bundle = b.buildDeliveryBundle({ envelope: e, signatures: "0x" });
    expect(b.parseDeliveryBundle(b.serializeDeliveryBundle(bundle)).evidence.signedSafeTx.safeTx.nonce).toBe(2n ** 200n);
  });
});

describe("hex case", () => {
  const upper = (hex: Hex) => `0x${hex.slice(2).toUpperCase()}` as Hex;
  it("accepts uppercase calldata and signatures and builds the form parse reads", () => {
    const e = s.signedDispatchTx(1n, SAFE, TRANSMITTER, 1n, s.signedSendData(DESTINATION, "0xc0de", []));
    const bundle = b.buildDeliveryBundle({ envelope: { ...e, tx: { ...e.tx, data: upper(e.tx.data) } }, signatures: "0xABCD" });
    expect(bundle.evidence.signedSafeTx).toMatchObject({ signatures: "0xabcd", safeTx: { data: e.tx.data } });
    expect(b.parseDeliveryBundle(b.serializeDeliveryBundle(bundle))).toEqual(bundle);
  });
  it("accepts a registration with uppercase calldata and lowercase-address Safes", () => {
    const e = s.signedDispatchTx(1n, SAFE, TRANSMITTER, 43n, s.registerRootData(pkg().root));
    const lowered = { ...e, safe: e.safe.toLowerCase() as Address, tx: { ...e.tx, data: upper(e.tx.data) } };
    const bundle = b.buildDeliveryBundle({ envelope: lowered, signatures: "0x", merkle: pkg() });
    expect(b.parseDeliveryBundle(b.serializeDeliveryBundle(bundle))).toEqual(bundle);
  });
  it("verifies a hand-built bundle with uppercase calldata", () => {
    const bundle = merkle();
    const { safeTx } = bundle.evidence.signedSafeTx;
    const edited = { ...bundle, evidence: { ...bundle.evidence, signedSafeTx: { ...bundle.evidence.signedSafeTx, safeTx: { ...safeTx, data: upper(safeTx.data) } } } };
    expect(() => b.verifyDeliveryBundle(edited)).not.toThrow();
  });
});

describe("verification matches the builders", () => {
  const envelopeFor = (data: Hex, chainId = 1n, nonce = 1n) => ({ chainId, safe: SAFE, tx: { ...s.signedDispatchTx(1n, SAFE, TRANSMITTER, 0n, "0x").tx, data, nonce } });
  it("rejects an empty signed payload", () => {
    const empty = encodeFunctionData({ abi: signedTransmitterAbi, functionName: "sendMessage", args: [DESTINATION, "0x", []] });
    expect(() => b.buildDeliveryBundle({ envelope: envelopeFor(empty), signatures: "0x" })).toThrow("empty signed payload");
  });
  it("rejects a zero or oversized chain id and an oversized nonce", () => {
    const send = s.signedSendData(DESTINATION, "0xc0de", []);
    expect(() => b.buildDeliveryBundle({ envelope: envelopeFor(send, 0n), signatures: "0x" })).toThrow("invalid source chain id");
    expect(() => b.buildDeliveryBundle({ envelope: envelopeFor(send, 2n ** 256n), signatures: "0x" })).toThrow("invalid source chain id");
    expect(() => b.buildDeliveryBundle({ envelope: envelopeFor(send, 1n, 2n ** 256n), signatures: "0x" })).toThrow("invalid Safe nonce or value");
  });
  it("rejects a parsed chain id or nonce at or above 2^256", () => {
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.homeChainId = (2n ** 256n).toString(); }))).toThrow("exceeds uint256");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.signedSafeTx.safeTx.nonce = (2n ** 256n).toString(); }))).toThrow("exceeds uint256");
  });
});

describe("delivery bundle checks", () => {
  it("rejects a changed Safe, chain or transaction field", () => {
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.safe = addr(0x9999); }))).toThrow("safeTxHash mismatch");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.homeChainId = "10"; }))).toThrow("safeTxHash mismatch");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.signedSafeTx.safeTx.value = "4"; }))).toThrow("safeTxHash mismatch");
  });
  it("requires a CALL", () => {
    const e = s.signedDispatchTx(1n, SAFE, TRANSMITTER, 1n, s.signedSendData(DESTINATION, "0xc0de", []));
    expect(() => b.buildDeliveryBundle({ envelope: { ...e, tx: { ...e.tx, operation: 1 } }, signatures: "0x" })).toThrow("must be a CALL");
  });
  it("accepts only an exact sendMessage when standalone", () => {
    const send = s.signedSendData(DESTINATION, "0xc0de", []);
    const build = (data: Hex) => () => b.buildDeliveryBundle({ envelope: s.signedDispatchTx(1n, SAFE, TRANSMITTER, 1n, data), signatures: "0x" });
    expect(build(send)).not.toThrow();
    expect(build(`${send}00`)).toThrow("not a signed sendMessage");
    expect(build(s.registerRootData(word(1)))).toThrow("not a signed sendMessage");
    expect(build("0x")).toThrow("not a signed sendMessage");
  });
  it("binds a Merkle bundle to a registration of its own root", () => {
    const build = (data: Hex) => () => b.buildDeliveryBundle({ envelope: s.signedDispatchTx(1n, SAFE, TRANSMITTER, 1n, data), signatures: "0x", merkle: pkg() });
    expect(build(s.registerRootData(pkg().root))).not.toThrow();
    expect(build(s.registerRootData(word(1)))).toThrow("not registerRoot of the package root");
    expect(build(s.signedSendData(DESTINATION, "0xc0de", []))).toThrow("not registerRoot of the package root");
  });
  it("rejects a package whose tree does not match its leaves", () => {
    expect(() => b.parseDeliveryBundle(edit(merkle(), (o) => { o.merkle.leaves[1].proof = []; }))).toThrow("proof mismatch at 1");
  });
  it("rejects duplicate nested approvals", () => {
    const e = s.signedDispatchTx(1n, SAFE, TRANSMITTER, 1n, s.signedSendData(DESTINATION, "0xc0de", []));
    expect(() => b.buildDeliveryBundle({ envelope: e, signatures: "0x", nestedApprovals: [nested, nested] })).toThrow("duplicate nested approval");
    expect(() => b.buildDeliveryBundle({ envelope: e, signatures: "0x", nestedApprovals: [nested, { ...nested, messageHash: word(6) }] })).not.toThrow();
  });
  it("rejects unknown versions, extra fields and malformed values", () => {
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.version = 2; }))).toThrow("unsupported delivery bundle version");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.extra = true; }))).toThrow("fields must be exactly");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { delete o.merkle; }))).toThrow("fields must be exactly");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.signedSafeTx.signatures = "0x123"; }))).toThrow("not complete hex bytes");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.signedSafeTx.safeTx.extra = "1"; }))).toThrow("fields must be exactly");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.homeChainId = 1; }))).toThrow("not a decimal string");
    expect(() => b.parseDeliveryBundle(edit(standalone(), (o) => { o.safe = "0x12"; }))).toThrow("not an address");
  });
});

describe("delivery from a bundle", () => {
  it("builds the same calldata as the direct builders", () => {
    const bundle = merkle(), { evidence } = bundle;
    pkg().leaves.forEach((entry, i) => {
      expect(b.relayLeafFromBundle(bundle, i)).toBe(s.relayLeafData(evidence, entry.leaf, entry.proof));
      expect(b.submitLeafFromBundle(bundle, i)).toBe(s.submitLeafData(evidence, entry.leaf, entry.proof));
    });
    expect(b.submitMessageFromBundle(standalone())).toBe(s.submitMessageData(standalone().evidence));
  });
  it("refuses the wrong delivery for the bundle", () => {
    expect(() => b.submitMessageFromBundle(merkle())).toThrow("not a standalone bundle");
    expect(() => b.relayLeafFromBundle(standalone(), 0)).toThrow("no such Merkle leaf");
    expect(() => b.relayLeafFromBundle(merkle(), 3)).toThrow("no such Merkle leaf");
  });
});
