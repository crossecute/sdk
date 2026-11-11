import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Address, type Hex, getAddress } from "viem";
import { chainKey, encodeBootstrap, encodeCalls, encodeEvm, encodeEvmChain } from "../src/encoding.js";

// Written by test/Vectors.t.sol from the protocol's own encoders.
const vectors = JSON.parse(readFileSync(new URL("../../vectors/encoding.json", import.meta.url), "utf8"));
const account = getAddress(vectors.account) as Address;

describe("encoding matches the protocol", () => {
  for (const v of vectors.chains) {
    const chainId = BigInt(v.chainId);
    it(`chain ${chainId}`, () => {
      expect(encodeEvmChain(chainId)).toBe(v.chainIdentifier);
      expect(chainKey(chainId)).toBe(v.chainKey);
      expect(encodeEvm(chainId, account)).toBe(v.account);
    });
  }

  it("calls and bootstrap payloads", () => {
    const calls = vectors.calls.map((c: any) => ({ target: c.target as Address, value: BigInt(c.value), data: c.data as Hex }));
    const body = encodeCalls(calls);
    expect(body).toBe(vectors.callsPayload);
    expect(encodeBootstrap(encodeEvmChain(10n), body)).toBe(vectors.bootstrapPayload);
  });

  it("refuses chain id zero", () => {
    expect(() => encodeEvmChain(0n)).toThrow();
  });
});
