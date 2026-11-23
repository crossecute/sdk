import { type Address, type Hex, concatHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SafeQueueSigner, buildDeliveryBundle, buildMerklePackage, encodeEvm, parseDeliveryBundle,
  registerRootCalldata, SafeQueue, serializeDeliveryBundle, serializeSafeTxFields, signedDispatchNotice,
  signedDispatchTx, sendMessageCalldataSigned, submitLeafFromBundle, submitMessageFromBundle,
} from "../src/index.js";

const safe = "0x0000000000000000000000000000000000000001";
const transmitter = "0x0000000000000000000000000000000000000002";
const receiver = "0x0000000000000000000000000000000000000003";
const destination = encodeEvm(8453n, receiver);
const calls = "0x1234";
const alice = privateKeyToAccount(toHex(0xA11CEn, { size: 32 }));
const bob = privateKeyToAccount(toHex(0xB0Bn, { size: 32 }));

function draft(kind: "standalone" | "merkle" = "standalone") {
  const merkle = kind === "merkle" ? buildMerklePackage(
    [0n, 1n].map((nonce) => ({ destination, nonce, validAfter: 0n, deadline: 100n, calls, attributes: [] })),
    [{ destination, nextNonce: 0n }],
  ) : undefined;
  const payload = merkle ? registerRootCalldata(merkle.root) : sendMessageCalldataSigned(destination, calls, []);
  return buildDeliveryBundle({ envelope: signedDispatchTx(10n, safe, transmitter, 42n, payload), signatures: "0x", merkle });
}

function signer(account: typeof alice, acknowledged = true) {
  const acknowledgment = vi.fn<SafeQueueSigner["acknowledge"]>(() => acknowledged);
  const signTypedData = vi.fn<SafeQueueSigner["signTypedData"]>(async (data) => {
    expect(acknowledgment).toHaveBeenCalledOnce();
    return account.signTypedData(data);
  });
  return { address: account.address, acknowledge: acknowledgment, signTypedData };
}

function mockQueue(input: ReturnType<typeof draft>) {
  const tx = input.evidence.signedSafeTx.safeTx;
  const record = {
    ...serializeSafeTxFields(tx), nonce: tx.nonce.toString(), operation: tx.operation,
    chainId: input.homeChainId.toString(), safe: input.safe,
    safeTxHash: input.safeTxHash, gasToken: null, refundReceiver: null, txHash: null,
    confirmations: [] as { owner: Address; signature: Hex }[],
  };
  const route = "https://api.safe.global/queue/api/v1/multisig-transactions";
  const request = vi.fn(async (url: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ authorization: "Bearer example-token" });
    if (options.method === "GET") {
      expect(url).toBe(`${route}/${input.safeTxHash}`);
      return Response.json(record);
    }
    const body = JSON.parse(options.body as string);
    if (url === route) {
      expect(body).toEqual({
        ...serializeSafeTxFields(tx), operation: tx.operation, chainId: record.chainId, safe: record.safe,
        originName: "Crossecute", signatures: [expect.any(String)],
      });
      record.confirmations.push({ owner: alice.address, signature: body.signatures[0] });
      return Response.json(record, { status: 201 });
    }
    expect(url).toBe(`${route}/${input.safeTxHash}/signatures`);
    expect(body).toEqual({ signatures: [expect.any(String)] });
    const confirmation = { owner: bob.address, signature: body.signatures[0] };
    record.confirmations.push(confirmation);
    return Response.json([confirmation], { status: 201 });
  });
  vi.stubGlobal("fetch", request);
  return { record, request };
}

afterEach(() => vi.unstubAllGlobals());

describe("signed dispatch through Safe Queue", () => {
  const queue = new SafeQueue({ apiKey: "example-token" });

  it.each(["standalone", "merkle"] as const)("proposes, confirms and exports a %s bundle before source execution", async (kind) => {
    const input = draft(kind);
    const { record } = mockQueue(input);
    const proposer = signer(alice);
    const confirmer = signer(bob);
    await expect(queue.propose(input, proposer)).resolves.toBe(input.safeTxHash);
    await expect(queue.confirm(input, confirmer)).resolves.toBe(input.safeTxHash);
    expect(proposer.acknowledge).toHaveBeenCalledWith(signedDispatchNotice, input);
    expect(confirmer.acknowledge).toHaveBeenCalledWith(signedDispatchNotice, input);

    const bundle = await queue.exportBundle(input, [alice.address, bob.address]);
    const independentBundle = parseDeliveryBundle(serializeDeliveryBundle(bundle));
    const orderedSignatures = [...record.confirmations]
      .sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()))
      .map(({ signature }) => signature);
    expect(independentBundle.evidence.signedSafeTx.signatures).toBe(concatHex(orderedSignatures));
    expect(independentBundle.merkle).toEqual(input.merkle);
    const calldata = kind === "merkle" ? submitLeafFromBundle(independentBundle, 0) : submitMessageFromBundle(independentBundle);
    expect(calldata.length).toBeGreaterThan(input.evidence.signedSafeTx.safeTx.data.length);
  });

  it("does not sign or publish when a signer declines", async () => {
    const input = draft();
    const { request } = mockQueue(input);
    const owner = signer(alice, false);
    await expect(queue.propose(input, owner)).rejects.toThrow("acknowledgment");
    expect(owner.signTypedData).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const confirmer = signer(bob, false);
    await expect(queue.confirm(input, confirmer)).rejects.toThrow("acknowledgment");
    expect(confirmer.signTypedData).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1].method).toBe("GET");
  });

  it("checks returned fields against the draft before asking a confirmer to sign", async () => {
    const input = draft();
    const { record } = mockQueue(input);
    record.nonce = "43";
    const owner = signer(bob);
    await expect(queue.confirm(input, owner)).rejects.toThrow("does not match");
    expect(owner.acknowledge).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate and nonportable confirmations at export", async () => {
    const input = draft();
    const { record } = mockQueue(input);
    await expect(queue.exportBundle(input, [alice.address])).rejects.toThrow("missing confirmation");
    await expect(queue.exportBundle(input, [alice.address, alice.address])).rejects.toThrow("distinct");
    record.confirmations.push({ owner: alice.address, signature: toHex(1, { size: 65 }) });
    await expect(queue.exportBundle(input, [alice.address])).rejects.toThrow("portable EOA signature");
    record.confirmations.push({ ...record.confirmations[0] });
    await expect(queue.exportBundle(input, [alice.address])).rejects.toThrow("duplicate confirmation");
  });

  it("preserves the Safe recovery byte for an eth_sign confirmation", async () => {
    const input = draft();
    const { record } = mockQueue(input);
    const signature = await alice.signMessage({ message: { raw: input.safeTxHash } });
    const v = Number.parseInt(signature.slice(-2), 16);
    const packed = concatHex([signature.slice(0, -2) as Hex, toHex(v + 4)]);
    record.confirmations.push({ owner: alice.address, signature: packed });
    const bundle = await queue.exportBundle(input, [alice.address]);
    expect(bundle.evidence.signedSafeTx.signatures).toBe(packed);
  });

  it("refuses to publish a signature from a different signer", async () => {
    const input = draft();
    const { request } = mockQueue(input);
    const owner = { ...signer(bob), address: alice.address };
    await expect(queue.propose(input, owner)).rejects.toThrow("signature does not match");
    expect(request).not.toHaveBeenCalled();
  });
});
