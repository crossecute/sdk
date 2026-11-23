import {
  type Address, type ContractFunctionArgs, type Hex, concat, encodeAbiParameters, encodeFunctionData, getCreate2Address, isAddress, isHex,
  keccak256, size, slice, stringToHex, zeroAddress, zeroHash,
} from "viem";
import { ILzOftConduitFactoryAbi } from "@crossecute/protocol/abi";
import { chainKey } from "./encoding.js";
import { type SafeTxEnvelope } from "./safeTx.js";
import { dispatchLeafHash, dispatchTreeFromHashes, signedDispatchTx } from "./signed.js";
import { lzOftConduitFactoryAbi } from "./signedAbi.js";

/** `LzMessage.OPTIONS_ATTRIBUTE`, the selector of the one attribute a `layerzero-oft` conduit accepts. */
export const LZ_OPTIONS_ATTRIBUTE: Hex = slice(keccak256(stringToHex("crossecute.lz.options")), 0, 4);
/**
 * `keccak256` of `Proxy`'s initcode at the pinned protocol release, which a conduit's CREATE2 address hashes.
 * The deployed factory's `PROXY_INIT_CODE_HASH()` is authoritative; `ts/test/lzOft.test.ts` compares this with
 * vectors/lzoft-protocol.json, which scripts/sync-protocol.py derives from protocol.
 */
export const LZ_OFT_PROXY_INIT_CODE_HASH: Hex = "0x825940f5905807e2b38780497d34b22480ffdb4cd09cdfd4720a194910beada6";

/** One destination of a conduit: its chain key, the endpoint id of that chain and the home OFT's peer there. */
export type LzOftDestination = ContractFunctionArgs<typeof ILzOftConduitFactoryAbi, "nonpayable", "createTransmitter">[2][number];
/** A destination named by chain id, for `lzOftDestinations`. */
export type LzOftDestinationInput = { chainId: bigint; eid: number; oft: Address };
/** The home chain's key and eid, for the checks that compare a destination with the home. */
export type LzOftHome = { chainKey: Hex; eid: number };

const leafType = [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }] as const;
const UINT32_MAX = 2 ** 32 - 1;

/**
 * The only attribute a `layerzero-oft` conduit accepts, `abi.encodePacked(OPTIONS_ATTRIBUTE, rawOptions)`.
 * `rawOptions` replace the default lzCompose option whole, so they must carry the compose gas the destination
 * needs, and a send takes at most this one attribute. Protocol reads a selector-only attribute as present with
 * empty options (`ProviderAttribute.body`), not as "use the defaults", and that would send with no lzCompose
 * option, so empty options are rejected here. Whole bytes of hex are required; the content is not validated.
 */
export function lzOptionsAttribute(rawOptions: Hex): Hex {
  if (!isHex(rawOptions) || rawOptions.length % 2 !== 0) throw new Error("options must be hex of whole bytes");
  if (rawOptions === "0x") throw new Error("options must not be empty");
  return concat([LZ_OPTIONS_ATTRIBUTE, rawOptions]);
}

/** The destination leaf hash computed by `LzOftConduitAddress.leafHash`. */
export function lzOftLeafHash(destination: LzOftDestination): Hex {
  return dispatchLeafHash(encodeAbiParameters(leafType, [destination.chainKey, destination.eid, destination.oft]));
}

/** Check the ordering, endpoint IDs and addresses that the factory can validate without reading its peers. */
export function requireLzOftDestinations(destinations: readonly LzOftDestination[], home?: LzOftHome): void {
  if (!destinations.length) throw new Error("NoDestinations");
  destinations.forEach((destination, i) => {
    if (!isHex(destination.chainKey) || size(destination.chainKey) !== 32) {
      throw new Error(`BadDestination(${i}): chain key is not 32 bytes`);
    }
    const key = BigInt(destination.chainKey);
    if (i && key <= BigInt(destinations[i - 1].chainKey)) throw new Error(`DestinationsNotSorted(${i})`);
    if (!Number.isInteger(destination.eid) || destination.eid <= 0 || destination.eid > UINT32_MAX) {
      throw new Error(`BadDestination(${i}): eid`);
    }
    if (!isAddress(destination.oft, { strict: false }) || destination.oft === zeroAddress) {
      throw new Error(`BadDestination(${i}): oft`);
    }
    if (key === BigInt(home?.chainKey ?? zeroHash) || (home && destination.eid === home.eid)) {
      throw new Error(`BadDestination(${i}): home or reserved chain key`);
    }
  });
}

/** Resolve chain IDs to chain keys and sort the destination records by ascending chain key. */
export function lzOftDestinations(inputs: readonly LzOftDestinationInput[], home?: LzOftHome): LzOftDestination[] {
  const destinations = inputs
    .map((d) => ({ chainKey: chainKey(d.chainId), eid: d.eid, oft: d.oft }))
    .sort((a, b) => (BigInt(a.chainKey) < BigInt(b.chainKey) ? -1 : BigInt(a.chainKey) > BigInt(b.chainKey) ? 1 : 0));
  requireLzOftDestinations(destinations, home);
  return destinations;
}

/** The factory's destination root over destination leaf hashes in ascending chain-key order. */
export function lzOftRoot(destinations: readonly LzOftDestination[], home?: LzOftHome): Hex {
  requireLzOftDestinations(destinations, home);
  return dispatchTreeFromHashes(destinations.map(lzOftLeafHash)).root;
}

/**
 * Calldata for the owner Safe to CALL `ILzOftConduitFactory.createTransmitter`. The factory checks peers
 * and fixes signed mode from the Safe's installed guard at creation.
 */
export function createLzOftTransmitterCalldata(salt: Hex, homeOft: Address, destinations: readonly LzOftDestination[]): Hex {
  requireLzOftDestinations(destinations);
  return encodeFunctionData({ abi: lzOftConduitFactoryAbi, functionName: "createTransmitter", args: [salt, homeOft, destinations] });
}

/** The owner Safe's CALL to the factory that creates the conduit, as `signedDispatchTx` builds any plain CALL. */
export function lzOftCreateTx(chainId: bigint, ownerSafe: Address, factory: Address, nonce: bigint, salt: Hex, homeOft: Address, destinations: readonly LzOftDestination[]): SafeTxEnvelope {
  return signedDispatchTx(chainId, ownerSafe, factory, nonce, createLzOftTransmitterCalldata(salt, homeOft, destinations));
}

export type LzOftConduitFields = { owner: Address; salt: Hex; homeChainKey: Hex; homeEid: number; homeOft: Address; destRoot: Hex };

/** `LzOftConduitFactory.conduitSalt`. */
export function lzOftConduitSalt(f: LzOftConduitFields): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }, { type: "address" }, { type: "bytes32" }],
    [f.owner, f.salt, f.homeChainKey, f.homeEid, f.homeOft, f.destRoot],
  ));
}

/**
 * `LzOftConduitFactory.predictConduit` for the factory at `factory`. The conduit's receiver is at this same
 * address on every destination. `proxyInitCodeHash` is required: pass the deployed factory's
 * `PROXY_INIT_CODE_HASH()`, which is what its own `predictConduit` hashes. `LZ_OFT_PROXY_INIT_CODE_HASH` is the
 * pinned release's value, for tests and for checking the deployed one.
 */
export function predictLzOftConduit(factory: Address, f: LzOftConduitFields, proxyInitCodeHash: Hex): Address {
  if (!isHex(proxyInitCodeHash) || size(proxyInitCodeHash) !== 32) throw new Error("proxy initcode hash must be 32 bytes");
  return getCreate2Address({ from: factory, salt: lzOftConduitSalt(f), bytecodeHash: proxyInitCodeHash });
}
