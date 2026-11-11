import { type Address, type Hex, concat, encodeAbiParameters, keccak256, numberToHex } from "viem";

/** One call in a payload: the ERC-7579 `Execution` tuple the protocol's `Call` uses. */
export type Call = { target: Address; value: bigint; data: Hex };

const VERSION_1 = "0x0001";
const CT_EIP155 = "0x0000";

/** The chain id as a minimal big-endian integer, as ERC-7930's eip155 profile requires. */
function chainRef(chainId: bigint): Hex {
  if (chainId <= 0n) throw new Error(`chain id must be positive: ${chainId}`);
  const hex = chainId.toString(16);
  return `0x${hex.length % 2 ? "0" : ""}${hex}`;
}

function lengthByte(bytes: Hex): Hex {
  const length = (bytes.length - 2) / 2;
  if (length > 255) throw new Error("ERC-7930 field longer than 255 bytes");
  return numberToHex(length, { size: 1 });
}

/** `Erc7930.encodeEvmChain`: an eip155 chain identifier with no address. */
export function encodeEvmChain(chainId: bigint): Hex {
  const ref = chainRef(chainId);
  return concat([VERSION_1, CT_EIP155, lengthByte(ref), ref, "0x00"]);
}

/** `Erc7930.encodeEvm`: an account on an eip155 chain. */
export function encodeEvm(chainId: bigint, account: Address): Hex {
  const ref = chainRef(chainId);
  return concat([VERSION_1, CT_EIP155, lengthByte(ref), ref, "0x14", account.toLowerCase() as Hex]);
}

/** `ChainKey.forEvm`. */
export function chainKey(chainId: bigint): Hex {
  return keccak256(encodeEvmChain(chainId));
}

const callsType = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/** `Payload.encodeCalls`: the wire bytes an EVM receiver decodes. */
export function encodeCalls(calls: readonly Call[]): Hex {
  return encodeAbiParameters(callsType, [calls]);
}

/** `Payload.encodeBootstrap`. */
export function encodeBootstrap(destinationChainIdentifier: Hex, body: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [destinationChainIdentifier, body]);
}
