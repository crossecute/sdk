import { TransmitterBaseAbi } from "@crossecute/protocol/abi";
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress, isHex } from "viem";
import { type Call, encodeBootstrap, encodeCalls, encodeEvm, encodeEvmChain } from "./encoding.js";

export const PLAN_VERSION = "crossecute-plan/1";

/** A call the conduit's owner makes on the home chain. */
export type HomeCall = { to: Address; value: bigint; data: Hex };

/** One batch for the conduit's receiver on an EVM destination, as the Foundry script simulated it. */
export type Batch = {
  chainId: bigint;
  receiver: Address;
  bootstrap: boolean;
  gasUsed: bigint;
  attributes: Hex[];
  calls: Call[];
};

/** What `CrossecuteScript._writePlan` writes. */
export type Plan = {
  homeChainId: bigint;
  owner: Address;
  transmitter: Address;
  fee: bigint;
  calls: HomeCall[];
  batches: Batch[];
};

function address(value: unknown, at: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`${at}: not an address`);
  return getAddress(value);
}

function hex(value: unknown, at: string): Hex {
  if (typeof value !== "string" || !isHex(value)) throw new Error(`${at}: not hex`);
  return value;
}

function uint(value: unknown, at: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new Error(`${at}: not a decimal string`);
  return BigInt(value);
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: not an array`);
  return value;
}

/** Parses and type-checks a plan file. Does not check that its calls match its batches; see `checkPlan`. */
export function parsePlan(json: string): Plan {
  const raw = JSON.parse(json);
  if (raw.version !== PLAN_VERSION) throw new Error(`unsupported plan version ${raw.version}`);
  return {
    homeChainId: uint(raw.homeChainId, "homeChainId"),
    owner: address(raw.owner, "owner"),
    transmitter: address(raw.transmitter, "transmitter"),
    fee: uint(raw.fee, "fee"),
    calls: array(raw.calls, "calls").map((c: any, i) => ({
      to: address(c.to, `calls[${i}].to`),
      value: uint(c.value, `calls[${i}].value`),
      data: hex(c.data, `calls[${i}].data`),
    })),
    batches: array(raw.batches, "batches").map((b: any, i) => {
      if (typeof b.bootstrap !== "boolean") throw new Error(`batches[${i}].bootstrap: not a boolean`);
      return {
        chainId: uint(b.chainId, `batches[${i}].chainId`),
        receiver: address(b.receiver, `batches[${i}].receiver`),
        bootstrap: b.bootstrap,
        gasUsed: uint(b.gasUsed, `batches[${i}].gasUsed`),
        attributes: array(b.attributes, `batches[${i}].attributes`).map((a, j) => hex(a, `batches[${i}].attributes[${j}]`)),
        calls: array(b.calls, `batches[${i}].calls`).map((c: any, j) => ({
          target: address(c.target, `batches[${i}].calls[${j}].target`),
          value: uint(c.value, `batches[${i}].calls[${j}].value`),
          data: hex(c.data, `batches[${i}].calls[${j}].data`),
        })),
      };
    }),
  };
}

/** The transmitter calldata that carries `batch`, as `CrossecuteScript._homeCallFor` builds it. */
export function homeCallData(batch: Batch): Hex {
  const body = encodeCalls(batch.calls);
  if (batch.bootstrap) {
    return encodeFunctionData({
      abi: TransmitterBaseAbi,
      functionName: "bootstrap",
      args: [encodeBootstrap(encodeEvmChain(batch.chainId), body), batch.attributes],
    });
  }
  return encodeFunctionData({
    abi: TransmitterBaseAbi,
    functionName: "sendMessage",
    args: [encodeEvm(batch.chainId, batch.receiver), body, batch.attributes],
  });
}

/**
 * Throws unless every home call is the transmitter call its batch implies, so a plan edited
 * after simulation cannot carry calldata other than what was simulated. Only the first call
 * may carry value: the transmitter top-up.
 */
export function checkPlan(plan: Plan): void {
  if (plan.calls.length === 0) throw new Error("plan has no calls");
  if (plan.calls.length !== plan.batches.length) throw new Error("plan has a different number of calls and batches");
  plan.calls.forEach((call, i) => {
    if (call.to !== plan.transmitter) throw new Error(`calls[${i}] is not to the transmitter`);
    if (i > 0 && call.value !== 0n) throw new Error(`calls[${i}] carries value`);
    if (call.data.toLowerCase() !== homeCallData(plan.batches[i])) throw new Error(`calls[${i}] does not carry batches[${i}]`);
  });
}
