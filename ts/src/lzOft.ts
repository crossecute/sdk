import {
  type Address, type Hex, concat, encodeAbiParameters, encodeFunctionData, getCreate2Address, isAddress, isHex,
  keccak256, size, slice, stringToHex, zeroAddress,
} from "viem";
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
export type LzOftLeaf = { chainKey: Hex; eid: number; oft: Address };
/** A destination named by chain id, for `lzOftLeaves`. */
export type LzOftDestination = { chainId: bigint; eid: number; oft: Address };
/** The home chain's key and eid, for the checks that compare a leaf with the home. */
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

/** `LzOftMessage.leaf`. */
export function lzOftLeafHash(leaf: LzOftLeaf): Hex {
  return dispatchLeafHash(encodeAbiParameters(leafType, [leaf.chainKey, leaf.eid, leaf.oft]));
}

/**
 * The factory's `_checkLeaves` without the checks that read the home OFT's peers: at least one leaf, strictly
 * ascending `chainKey` (a repeat is refused too), and a nonzero eid and OFT. With `home`, no leaf may name the
 * home chain or the home's eid. Messages name the factory's errors.
 */
export function requireLzOftLeaves(leaves: readonly LzOftLeaf[], home?: LzOftHome): void {
  if (!leaves.length) throw new Error("NoDestinations");
  leaves.forEach((l, i) => {
    if (!isHex(l.chainKey) || size(l.chainKey) !== 32) throw new Error(`BadLeaf(${i}): chain key is not 32 bytes`);
    if (i && BigInt(l.chainKey) <= BigInt(leaves[i - 1].chainKey)) throw new Error(`LeavesNotSorted(${i})`);
    if (!Number.isInteger(l.eid) || l.eid <= 0 || l.eid > UINT32_MAX) throw new Error(`BadLeaf(${i}): eid`);
    if (!isAddress(l.oft, { strict: false }) || l.oft === zeroAddress) throw new Error(`BadLeaf(${i}): oft`);
    if (home && (BigInt(l.chainKey) === BigInt(home.chainKey) || l.eid === home.eid)) throw new Error(`BadLeaf(${i}): the home`);
  });
}

/**
 * Leaves for `destinations` in the ascending `chainKey` order the factory requires. Chain keys are hashes, so the
 * order is not the chain id order. Two destinations on one chain are rejected.
 */
export function lzOftLeaves(destinations: readonly LzOftDestination[], home?: LzOftHome): LzOftLeaf[] {
  const leaves = destinations
    .map((d) => ({ chainKey: chainKey(d.chainId), eid: d.eid, oft: d.oft }))
    .sort((a, b) => (BigInt(a.chainKey) < BigInt(b.chainKey) ? -1 : BigInt(a.chainKey) > BigInt(b.chainKey) ? 1 : 0));
  requireLzOftLeaves(leaves, home);
  return leaves;
}

/**
 * `LzOftMessage.root`: the `destRoot` the factory computes from `leaves` and binds into the conduit's address.
 * The leaves must already be in ascending `chainKey` order (see `lzOftLeaves`).
 */
export function lzOftRoot(leaves: readonly LzOftLeaf[], home?: LzOftHome): Hex {
  requireLzOftLeaves(leaves, home);
  return dispatchTreeFromHashes(leaves.map(lzOftLeafHash)).root;
}

/**
 * `LzOftConduitFactory.createTransmitter(salt, homeOft, leaves)`. The owner is the caller, so the owner Safe sends
 * this as a CALL to the factory. Plain and signed conduits are created the same way: the factory fixes signed mode
 * when the owner Safe's guard is installed at that moment, which this package cannot read. Peers, eids and the
 * guard are not checked here.
 */
export function createLzOftTransmitterCalldata(salt: Hex, homeOft: Address, leaves: readonly LzOftLeaf[]): Hex {
  requireLzOftLeaves(leaves);
  return encodeFunctionData({ abi: lzOftConduitFactoryAbi, functionName: "createTransmitter", args: [salt, homeOft, leaves] });
}

/** The owner Safe's CALL to the factory that creates the conduit, as `signedDispatchTx` builds any plain CALL. */
export function lzOftCreateTx(chainId: bigint, ownerSafe: Address, factory: Address, nonce: bigint, salt: Hex, homeOft: Address, leaves: readonly LzOftLeaf[]): SafeTxEnvelope {
  return signedDispatchTx(chainId, ownerSafe, factory, nonce, createLzOftTransmitterCalldata(salt, homeOft, leaves));
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
