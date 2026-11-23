import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Address, type Hex, decodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress, zeroHash } from "viem";
import { chainKey } from "../src/encoding.js";
import * as sdk from "../src/index.js";
import {
  LZ_OFT_PROXY_INIT_CODE_HASH, LZ_OPTIONS_ATTRIBUTE, requireLzOftLeaves, createLzOftTransmitterCalldata, lzOftConduitSalt,
  lzOftCreateTx, lzOftLeafHash, lzOftLeaves, lzOftRoot, lzOptionsAttribute, predictLzOftConduit, type LzOftLeaf,
} from "../src/lzOft.js";
import { lzOftConduitFactoryAbi, signedTransmitterAbi } from "../src/signedAbi.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, new URL("../../", import.meta.url)), "utf8"));
const vector = read("vectors/lzoft.json") as {
  options: Hex; optionsAttribute: Hex; proxyInitCodeHash: Hex; conduitLeaves: number; roots: Record<string, Hex>; factory: Address; createData: Hex; conduitSalt: Hex; conduit: Address;
  destinations: { chainId: string; chainKey: Hex; eid: number; oft: Address; leafHash: Hex }[];
  home: { owner: Address; salt: Hex; chainId: string; chainKey: Hex; eid: number; oft: Address };
};
const pins = read("vectors/lzoft-protocol.json");
const leaves: LzOftLeaf[] = vector.destinations.map((d) => ({ chainKey: d.chainKey, eid: d.eid, oft: d.oft }));
const home = { chainKey: vector.home.chainKey, eid: vector.home.eid };
const fields = { owner: vector.home.owner, salt: vector.home.salt, homeChainKey: vector.home.chainKey, homeEid: vector.home.eid, homeOft: vector.home.oft };
const conduitLeaves = leaves.slice(0, vector.conduitLeaves);
const conduitRoot = lzOftRoot(conduitLeaves, home);

describe("OFT constants against protocol", () => {
  it("repeat the selector and Proxy initcode hash protocol's sources and artifacts give", () => {
    expect(pins.optionsAttribute.selector).toBe(keccak256(stringToHex(pins.optionsAttribute.string)).slice(0, 10));
    expect(LZ_OPTIONS_ATTRIBUTE).toBe(pins.optionsAttribute.selector);
    expect(LZ_OFT_PROXY_INIT_CODE_HASH).toBe(pins.proxyInitCodeHash.hash);
  });
});

describe("options attribute", () => {
  it("is the selector then the raw options", () => {
    expect(lzOptionsAttribute(vector.options)).toBe(vector.optionsAttribute);
    expect(lzOptionsAttribute("0x0003aa")).toBe(`${LZ_OPTIONS_ATTRIBUTE}0003aa`);
  });
  it("rejects non-hex, odd length and empty options", () => {
    expect(() => lzOptionsAttribute("0003aa" as Hex)).toThrow("hex");
    expect(() => lzOptionsAttribute("0x0003a")).toThrow("whole bytes");
    expect(() => lzOptionsAttribute("0xzz")).toThrow("hex");
    expect(() => lzOptionsAttribute("0x")).toThrow("empty");
  });
  it("travels unchanged through the signed builders", () => {
    const attributes = [lzOptionsAttribute(vector.options)];
    const send = decodeFunctionData({ abi: signedTransmitterAbi, data: sdk.sendMessageCalldataSigned("0x00010000010a141111111111111111111111111111111111111111", "0xabcdef", attributes) });
    expect(send.args?.[2]).toEqual(attributes);
    const bootstrap = decodeFunctionData({ abi: signedTransmitterAbi, data: sdk.bootstrapCalldataSigned("0x00010000010a00", {
      guard: zeroAddress, updateHead: "0x" + "11".repeat(32) as Hex, setupCalls: sdk.encodeCalls([]),
      authority: { nodes: [{ record: { safe: fields.owner, threshold: 1n, owners: [{ owner: "0x0000000000000000000000000000000000005555", kind: 0 }] }, position: zeroHash }] },
    }, fields.owner, attributes) });
    expect(bootstrap.args?.[1]).toEqual(attributes);
  });
});

describe("destination leaves and root against the Solidity builders", () => {
  it("hash each leaf", () => {
    leaves.forEach((leaf, i) => expect(lzOftLeafHash(leaf)).toBe(vector.destinations[i].leafHash));
  });
  it("order destinations by chain key, whatever order they are given in", () => {
    const destinations = vector.destinations.map((d) => ({ chainId: BigInt(d.chainId), eid: d.eid, oft: d.oft }));
    expect(lzOftLeaves(destinations)).toEqual(leaves);
    expect(lzOftLeaves([...destinations].reverse())).toEqual(leaves);
    expect(destinations.map((d) => d.chainId)).not.toEqual([...destinations.map((d) => d.chainId)].sort((a, b) => (a < b ? -1 : 1)));
    expect(leaves.map((l) => l.chainKey)).toEqual(destinations.map((d) => chainKey(d.chainId)));
  });
  for (const [count, root] of Object.entries(vector.roots)) {
    it(`root of ${count} leaves`, () => expect(lzOftRoot(leaves.slice(0, Number(count)))).toBe(root));
  }
  it("is sensitive to every leaf field and to the order", () => {
    const root = lzOftRoot(leaves.slice(0, 2));
    expect(lzOftRoot([{ ...leaves[0], eid: leaves[0].eid + 1 }, leaves[1]])).not.toBe(root);
    expect(lzOftRoot([{ ...leaves[0], oft: zeroAddress.replace(/0$/, "1") as Address }, leaves[1]])).not.toBe(root);
  });
});

describe("leaf checks", () => {
  const [a, b] = leaves;
  it("refuse no leaves", () => expect(() => lzOftRoot([])).toThrow("NoDestinations"));
  it("refuse unsorted leaves", () => {
    expect(() => lzOftRoot([b, a])).toThrow("LeavesNotSorted(1)");
    expect(() => createLzOftTransmitterCalldata(fields.salt, fields.homeOft, [b, a])).toThrow("LeavesNotSorted(1)");
  });
  it("refuse a repeated chain key", () => {
    expect(() => lzOftRoot([a, a])).toThrow("LeavesNotSorted(1)");
    expect(() => lzOftRoot([a, { ...a, eid: a.eid + 1 }])).toThrow("LeavesNotSorted(1)");
    expect(() => lzOftLeaves([{ chainId: 10n, eid: 1, oft: a.oft }, { chainId: 10n, eid: 2, oft: b.oft }])).toThrow("LeavesNotSorted(1)");
  });
  it("refuse a zero or out of range eid, a zero OFT and a malformed key", () => {
    expect(() => requireLzOftLeaves([{ ...a, eid: 0 }])).toThrow("BadLeaf(0)");
    expect(() => requireLzOftLeaves([{ ...a, eid: 2 ** 32 }])).toThrow("BadLeaf(0)");
    expect(() => requireLzOftLeaves([{ ...a, eid: 1.5 }])).toThrow("BadLeaf(0)");
    expect(() => requireLzOftLeaves([a, { ...b, oft: zeroAddress }])).toThrow("BadLeaf(1)");
    expect(() => requireLzOftLeaves([{ ...a, chainKey: "0x01" }])).toThrow("BadLeaf(0)");
  });
  it("refuse the home chain and the home's eid when the home is given", () => {
    expect(() => requireLzOftLeaves([a, b], home)).not.toThrow();
    expect(() => requireLzOftLeaves([a, b], { ...home, chainKey: b.chainKey })).toThrow("BadLeaf(1)");
    expect(() => requireLzOftLeaves([a, b], { ...home, eid: a.eid })).toThrow("BadLeaf(0)");
    expect(() => lzOftLeaves([{ chainId: BigInt(vector.home.chainId), eid: 7, oft: a.oft }], home)).toThrow("BadLeaf(0)");
  });
});

describe("conduit creation and address against the Solidity builders", () => {
  it("encodes the factory's createTransmitter call", () => {
    const data = createLzOftTransmitterCalldata(fields.salt, fields.homeOft, conduitLeaves);
    expect(data).toBe(vector.createData);
    const decoded = decodeFunctionData({ abi: lzOftConduitFactoryAbi, data });
    expect(decoded.functionName).toBe("createTransmitter");
    expect(decoded.args).toEqual([fields.salt, getAddress(fields.homeOft), conduitLeaves.map((l) => ({ ...l, oft: getAddress(l.oft) }))]);
  });
  it("derives the salt and the address from the six fields and the factory", () => {
    expect(lzOftConduitSalt({ ...fields, destRoot: conduitRoot })).toBe(vector.conduitSalt);
    expect(predictLzOftConduit(vector.factory, { ...fields, destRoot: conduitRoot }, vector.proxyInitCodeHash).toLowerCase()).toBe(vector.conduit.toLowerCase());
  });
  it("moves the address with each bound field, the factory and the initcode hash", () => {
    const base = { ...fields, destRoot: conduitRoot };
    const at = predictLzOftConduit(vector.factory, base, vector.proxyInitCodeHash);
    const other = "0x0000000000000000000000000000000000000001" as Address;
    for (const changed of [
      { ...base, owner: other }, { ...base, salt: zeroHash }, { ...base, homeChainKey: zeroHash }, { ...base, homeEid: base.homeEid + 1 },
      { ...base, homeOft: other }, { ...base, destRoot: lzOftRoot(leaves.slice(0, 2)) },
    ]) expect(predictLzOftConduit(vector.factory, changed, vector.proxyInitCodeHash)).not.toBe(at);
    expect(predictLzOftConduit(other, base, vector.proxyInitCodeHash)).not.toBe(at);
    expect(predictLzOftConduit(vector.factory, base, zeroHash)).not.toBe(at);
  });
  it("takes the initcode hash explicitly and requires 32 bytes", () => {
    expect(vector.proxyInitCodeHash).toBe(LZ_OFT_PROXY_INIT_CODE_HASH);
    expect(() => predictLzOftConduit(vector.factory, { ...fields, destRoot: conduitRoot }, "0x1234")).toThrow("32 bytes");
    expect(() => (predictLzOftConduit as (...a: unknown[]) => unknown)(vector.factory, { ...fields, destRoot: conduitRoot })).toThrow("32 bytes");
  });
  it("wraps the call in the owner Safe's CALL to the factory", () => {
    const owner = vector.home.owner;
    const envelope = lzOftCreateTx(BigInt(vector.home.chainId), owner, vector.factory, 4n, fields.salt, fields.homeOft, conduitLeaves);
    expect(envelope).toMatchObject({ chainId: BigInt(vector.home.chainId), safe: owner, tx: { to: vector.factory, value: 0n, nonce: 4n, operation: 0, data: vector.createData } });
  });
});
