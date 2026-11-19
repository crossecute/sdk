import { type Hex, getAddress, type Address } from "viem";

/** Strict readers for exported JSON: decimal-string integers, complete hex bytes, exact key sets. */
export function uint(v: unknown, at: string): bigint {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new Error(`${at}: not a decimal string`);
  const n = BigInt(v);
  if (n >= 2n ** 256n) throw new Error(`${at}: exceeds uint256`);
  return n;
}

export function bytesHex(v: unknown, at: string): Hex {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error(`${at}: not complete hex bytes`);
  return v.toLowerCase() as Hex;
}

export function word(v: unknown, at: string): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${at}: not a 32-byte hex word`);
  return v.toLowerCase() as Hex;
}

export function address(v: unknown, at: string): Address {
  if (typeof v !== "string") throw new Error(`${at}: not an address`);
  try {
    return getAddress(v);
  } catch {
    throw new Error(`${at}: not an address`);
  }
}

export function object(v: unknown, keys: readonly string[], at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${at}: not an object`);
  if (Object.keys(v).sort().join() !== [...keys].sort().join()) throw new Error(`${at}: fields must be exactly ${keys.join(", ")}`);
  return v as Record<string, unknown>;
}

export function array(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${at}: not an array`);
  return v;
}
