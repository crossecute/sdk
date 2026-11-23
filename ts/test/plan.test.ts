import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requirePlan, parsePlan } from "../src/plan.js";

// Written by test/CrossecuteScript.t.sol's test_planFile.
const json = readFileSync(new URL("../../out/test-plan.json", import.meta.url), "utf8");

type PlanBytesFixture = {
  calls: { data: string }[];
  batches: { attributes: string[]; calls: { data: string }[] }[];
};

describe("plan files", () => {
  it("parses and checks a plan the Foundry script wrote", () => {
    const plan = parsePlan(json);
    expect(plan.batches[0].bootstrap).toBe(true);
    expect(plan.batches[0].attributes).toEqual(["0xdeadbeef"]);
    expect(() => requirePlan(plan)).not.toThrow();
  });

  it("rejects calldata that does not carry its batch", () => {
    const plan = parsePlan(json);
    plan.batches[0].calls[0].data = "0x00";
    expect(() => requirePlan(plan)).toThrow("does not carry batches[0]");
  });

  it("rejects a call to another address", () => {
    const plan = parsePlan(json);
    plan.calls[0].to = "0x0000000000000000000000000000000000000001";
    expect(() => requirePlan(plan)).toThrow("not to the transmitter");
  });

  it("rejects an unknown version", () => {
    expect(() => parsePlan(json.replace("crossecute-plan/1", "crossecute-plan/2"))).toThrow("unsupported plan version");
  });

  it("rejects a non-decimal amount", () => {
    const raw = JSON.parse(json);
    raw.fee = 1;
    expect(() => parsePlan(JSON.stringify(raw))).toThrow("fee: not a decimal string");
  });

  it("accepts the largest uint256 and rejects the next integer", () => {
    const raw = JSON.parse(json);
    const limit = 2n ** 256n;
    raw.fee = (limit - 1n).toString();
    expect(parsePlan(JSON.stringify(raw)).fee).toBe(limit - 1n);
    raw.fee = limit.toString();
    expect(() => parsePlan(JSON.stringify(raw))).toThrow("fee: exceeds uint256");
  });

  it.each<[string, (raw: PlanBytesFixture) => void]>([
    ["calls[0].data", (raw) => {
      raw.calls[0].data = "0x1";
    }],
    ["batches[0].attributes[0]", (raw) => {
      raw.batches[0].attributes[0] = "0x1";
    }],
    ["batches[0].calls[0].data", (raw) => {
      raw.batches[0].calls[0].data = "0x1";
    }],
  ])("rejects incomplete hex bytes at %s", (field, change) => {
    const raw = JSON.parse(json);
    change(raw);
    expect(() => parsePlan(JSON.stringify(raw))).toThrow(`${field}: not complete hex bytes`);
  });

  it("treats uppercase hex digits as the same bytes when parsing and checking", () => {
    const raw = JSON.parse(json);
    raw.batches[0].attributes[0] = "0xDEADBEEF";
    const plan = parsePlan(JSON.stringify(raw));
    expect(plan.batches[0].attributes[0]).toBe("0xdeadbeef");
    expect(() => requirePlan(plan)).not.toThrow();
    plan.batches[0].attributes[0] = "0xDEADBEEF";
    expect(() => requirePlan(plan)).not.toThrow();
  });
});
