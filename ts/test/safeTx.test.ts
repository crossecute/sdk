import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/plan.js";
import { checkSafeTx, multiSendCallOnly, parseSafeTxTypedData, safeTxHashes } from "../src/safeTx.js";

// Written by test/SafeTx.t.sol's test_typedDataFile: a two-batch plan through MultiSendCallOnly.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const envelopeJson = read("out/test-safe-tx.json");
const plan = parsePlan(read("out/test-safe-tx-plan.json"));
const solidityHash = read("out/test-safe-tx-hash.txt").trim();

describe("Safe transaction typed data", () => {
  it("hashes as Solidity and the Safe do", () => {
    expect(safeTxHashes(parseSafeTxTypedData(envelopeJson)).safeTxHash).toBe(solidityHash);
  });

  it("carries exactly the plan's calls", () => {
    expect(() => checkSafeTx(plan, parseSafeTxTypedData(envelopeJson))).not.toThrow();
  });

  it("rejects MultiSend data that differs", () => {
    const envelope = parseSafeTxTypedData(envelopeJson);
    envelope.tx.data = `${envelope.tx.data}00`;
    expect(() => checkSafeTx(plan, envelope)).toThrow("MultiSend data");
  });

  it("rejects an unknown MultiSend", () => {
    const envelope = parseSafeTxTypedData(envelopeJson);
    envelope.tx.to = "0x0000000000000000000000000000000000000001";
    expect(() => checkSafeTx(plan, envelope)).toThrow("known MultiSendCallOnly");
  });

  it("rejects another Safe's domain", () => {
    const envelope = parseSafeTxTypedData(envelopeJson);
    envelope.safe = "0x0000000000000000000000000000000000000001";
    expect(() => checkSafeTx(plan, envelope)).toThrow("not the plan's owner");
  });

  it("rejects a gas refund", () => {
    const envelope = parseSafeTxTypedData(envelopeJson);
    envelope.tx.gasPrice = 1n;
    expect(() => checkSafeTx(plan, envelope)).toThrow("gas or refund");
  });

  it("rejects an extra domain field", () => {
    const raw = JSON.parse(envelopeJson);
    raw.domain.name = "Safe";
    expect(() => parseSafeTxTypedData(JSON.stringify(raw))).toThrow("exactly chainId and verifyingContract");
  });

  it("rejects reordered types", () => {
    const raw = JSON.parse(envelopeJson);
    raw.types.SafeTx.reverse();
    expect(() => parseSafeTxTypedData(JSON.stringify(raw))).toThrow("SafeTx types");
  });

  it("repeats the Solidity MultiSendCallOnly table", () => {
    expect(multiSendCallOnly).toEqual(JSON.parse(read("vectors/multisend.json")));
  });
});
