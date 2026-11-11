import { type Address, type Hex, concat, encodeFunctionData, getAddress, hashDomain, hashStruct, hashTypedData, numberToHex, padHex } from "viem";
import { type Plan, checkPlan } from "./plan.js";

/** Safe's EIP-712 `SafeTx`. */
export type SafeTx = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
};

/** A Safe transaction with the domain it is signed under. */
export type SafeTxEnvelope = { chainId: bigint; safe: Address; tx: SafeTx };

export const safeTxTypes = {
  EIP712Domain: [
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * MultiSendCallOnly deployments by Safe version, from @safe-global/safe-deployments 1.37.67.
 * `CrossecuteScript._knownMultiSendCallOnly` holds the same table; test/Vectors.t.sol writes
 * it to vectors/ so the two are compared.
 */
export const multiSendCallOnly: Record<string, { addresses: Address[]; codeHash: Hex }> = {
  "1.3.0": {
    addresses: ["0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", "0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B"],
    codeHash: "0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad",
  },
  "1.4.1": {
    addresses: ["0x9641d764fc13c8B624c04430C7356C1C7C8102e2"],
    codeHash: "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939",
  },
  "1.5.0": {
    addresses: ["0xA83c336B20401Af773B6219BA5027174338D1836"],
    codeHash: "0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663",
  },
};

const multiSendAbi = [
  { type: "function", name: "multiSend", inputs: [{ name: "transactions", type: "bytes" }], outputs: [], stateMutability: "payable" },
] as const;

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Parses typed data written by `CrossecuteScript._writeSafeTx`, refusing any other shape. */
export function parseSafeTxTypedData(json: string): SafeTxEnvelope {
  const raw = JSON.parse(json);
  if (JSON.stringify(raw.types) !== JSON.stringify(safeTxTypes)) throw new Error("types are not Safe's SafeTx types");
  if (raw.primaryType !== "SafeTx") throw new Error("primaryType is not SafeTx");
  const domainKeys = Object.keys(raw.domain ?? {}).sort().join();
  if (domainKeys !== "chainId,verifyingContract") throw new Error("domain must hold exactly chainId and verifyingContract");
  const m = raw.message ?? {};
  const keys = safeTxTypes.SafeTx.map((f) => f.name);
  if (Object.keys(m).sort().join() !== [...keys].sort().join()) throw new Error("message fields are not SafeTx's");
  const uint = (v: unknown, at: string) => {
    if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new Error(`${at}: not a decimal string`);
    return BigInt(v);
  };
  const operation = uint(m.operation, "operation");
  if (operation > 1n) throw new Error("operation is not 0 or 1");
  if (typeof m.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(m.data)) throw new Error("data: not complete hex bytes");
  return {
    chainId: uint(raw.domain.chainId, "domain.chainId"),
    safe: getAddress(raw.domain.verifyingContract),
    tx: {
      to: getAddress(m.to),
      value: uint(m.value, "value"),
      data: m.data.toLowerCase() as Hex,
      operation: Number(operation) as 0 | 1,
      safeTxGas: uint(m.safeTxGas, "safeTxGas"),
      baseGas: uint(m.baseGas, "baseGas"),
      gasPrice: uint(m.gasPrice, "gasPrice"),
      gasToken: getAddress(m.gasToken),
      refundReceiver: getAddress(m.refundReceiver),
      nonce: uint(m.nonce, "nonce"),
    },
  };
}

/** The domain hash, message hash and `safeTxHash` a signer's device shows. */
export function safeTxHashes({ chainId, safe, tx }: SafeTxEnvelope): { domainHash: Hex; messageHash: Hex; safeTxHash: Hex } {
  const domain = { chainId, verifyingContract: safe };
  return {
    domainHash: hashDomain({ domain, types: safeTxTypes }),
    messageHash: hashStruct({ data: tx, primaryType: "SafeTx", types: safeTxTypes }),
    safeTxHash: hashTypedData({ domain, types: safeTxTypes, primaryType: "SafeTx", message: tx }),
  };
}

/** `CrossecuteScript._multiSendPacked` followed by the `multiSend` call. */
export function multiSendData(calls: Plan["calls"]): Hex {
  const packed = concat(
    calls.flatMap((c) => [
      "0x00",
      c.to.toLowerCase() as Hex,
      padHex(numberToHex(c.value), { size: 32 }),
      padHex(numberToHex((c.data.length - 2) / 2), { size: 32 }),
      c.data.toLowerCase() as Hex,
    ]),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

/**
 * Throws unless `envelope` is the one Safe transaction that carries `plan`: under the owner
 * Safe's domain on the home chain, with no gas refund, and either the plan's one call directly
 * or all of them through a known MultiSendCallOnly.
 */
export function checkSafeTx(plan: Plan, envelope: SafeTxEnvelope): void {
  checkPlan(plan);
  const { tx } = envelope;
  if (envelope.chainId !== plan.homeChainId) throw new Error(`domain chain ${envelope.chainId} is not the plan's ${plan.homeChainId}`);
  if (envelope.safe !== plan.owner) throw new Error(`domain Safe ${envelope.safe} is not the plan's owner ${plan.owner}`);
  if (tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n || tx.gasToken !== ZERO || tx.refundReceiver !== ZERO) {
    throw new Error("the transaction sets gas or refund fields");
  }
  if (plan.calls.length === 1) {
    const [c] = plan.calls;
    if (tx.operation !== 0 || tx.to !== c.to || tx.value !== c.value || tx.data !== c.data.toLowerCase()) {
      throw new Error("the transaction is not the plan's call");
    }
    return;
  }
  const known = Object.values(multiSendCallOnly).some((d) => d.addresses.includes(tx.to));
  if (tx.operation !== 1 || !known) throw new Error("the transaction does not delegatecall a known MultiSendCallOnly");
  if (tx.value !== 0n) throw new Error("the MultiSend call carries value");
  if (tx.data !== multiSendData(plan.calls)) throw new Error("the MultiSend data is not the plan's calls");
}
