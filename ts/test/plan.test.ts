import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPlan, parsePlan } from "../src/plan.js";

// Written by test/CrossecuteScript.t.sol's test_planFile.
const json = readFileSync(new URL("../../out/test-plan.json", import.meta.url), "utf8");

describe("plan files", () => {
  it("parses and checks a plan the Foundry script wrote", () => {
    const plan = parsePlan(json);
    expect(plan.batches[0].bootstrap).toBe(true);
    expect(plan.batches[0].attributes).toEqual(["0xdeadbeef"]);
    expect(() => checkPlan(plan)).not.toThrow();
  });

  it("rejects calldata that does not carry its batch", () => {
    const plan = parsePlan(json);
    plan.batches[0].calls[0].data = "0x00";
    expect(() => checkPlan(plan)).toThrow("does not carry batches[0]");
  });

  it("rejects a call to another address", () => {
    const plan = parsePlan(json);
    plan.calls[0].to = "0x0000000000000000000000000000000000000001";
    expect(() => checkPlan(plan)).toThrow("not to the transmitter");
  });

  it("rejects an unknown version", () => {
    expect(() => parsePlan(json.replace("crossecute-plan/1", "crossecute-plan/2"))).toThrow("unsupported plan version");
  });

  it("rejects a non-decimal amount", () => {
    const raw = JSON.parse(json);
    raw.fee = 1;
    expect(() => parsePlan(JSON.stringify(raw))).toThrow("fee: not a decimal string");
  });
});
