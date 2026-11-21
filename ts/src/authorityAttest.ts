import { type Address, type PublicClient, getAddress } from "viem";
import { type AuthorityRelayPlan, buildAuthorityRelayBatch } from "./authority.js";
import { type SafeTxEnvelope, safeTxHashes } from "./safeTx.js";

const scriptPath = "script/RelayAuthority.s.sol";
const outputPath = "out/authority-relay-safe-tx.json";

type AttestConfig = {
  producerRepo: string;
  producerCommit?: string;
  sourceRpcEnv: string;
  safeNetwork: string;
};

function rpcName(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error("invalid RPC environment variable name");
  return value;
}

function hex(value: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error("invalid relay bytes");
  return `hex"${value.slice(2)}"`;
}

function relayFields(plan: AuthorityRelayPlan, variable: string): string {
  const { safe, chainId, tx } = plan.envelope;
  return `        ${variable}.sourceChainId = ${chainId};
        ${variable}.safe = ${getAddress(safe)};
        ${variable}.nonce = ${tx.nonce};
        ${variable}.transmitter = ${getAddress(tx.to)};
        ${variable}.destinationChainId = ${plan.destinationChainId};
        ${variable}.destinationBlock = ${plan.destinationBlock};
        ${variable}.receiver = ${getAddress(plan.receiver)};
        ${variable}.previousHead = bytes32(${hex(plan.destination.updateHead)});
        ${variable}.previousAuthorityHash = bytes32(${hex(plan.destination.authorityHash)});
        ${variable}.recipient = ${hex(plan.recipient)};
        ${variable}.submission = ${hex(plan.update.bytes)};
        ${variable}.attributes = new bytes[](${plan.attributes.length});
${plan.attributes.map((attribute, i) => `        ${variable}.attributes[${i}] = ${hex(attribute)};\n`).join("")}`;
}

function scaffold(body: string, envelope: SafeTxEnvelope, sourceBlock: bigint, config: AttestConfig) {
  const { producerRepo, producerCommit, sourceRpcEnv, safeNetwork } = config;
  if (producerCommit && !/^[0-9a-f]{40}$/.test(producerCommit)) throw new Error("pin the full Forge producer commit");
  const { safe, tx } = envelope;
  const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuthorityRelayScript} from "@crossecute/sdk/AuthorityRelayScript.sol";

contract RelayAuthority is AuthorityRelayScript {
    function run() external {
${body}    }
}
`;
  const { safeTxHash } = safeTxHashes(envelope);
  const claim = `producer_repo = ${JSON.stringify(producerRepo)}
producer_commit = ${JSON.stringify(producerCommit ?? "<commit containing the generated script>")}
producer_setup = "pnpm install --frozen-lockfile --ignore-scripts"

[[run]]
script = "${scriptPath}:RelayAuthority"
rpc_env = "${rpcName(sourceRpcEnv)}"
fork_block = "${sourceBlock}"

[[run.claim]]
output_path = "${outputPath}"
input_format = "safe-eip712"
safe_network = ${JSON.stringify(safeNetwork)}
safe_address = "${safe}"
safe_nonce = "${tx.nonce}"
safe_version = "1.5.0"
expected_safe_tx_hash = "${safeTxHash}"
`;
  return { scriptPath, source, claim, outputPath, safeTxHash };
}

export function scaffoldAuthorityRelay(plan: AuthorityRelayPlan, config: AttestConfig & { destinationRpcEnv: string }) {
  const body = `        Relay memory relay;
${relayFields(plan, "relay")}        _writeAuthorityRelay(relay, vm.envString("${rpcName(config.destinationRpcEnv)}"), "${outputPath}");
`;
  return scaffold(body, plan.envelope, plan.sourceBlock, config);
}

export async function scaffoldAuthorityRelayBatch(
  plans: readonly { plan: AuthorityRelayPlan; destinationRpcEnv: string }[],
  multicall: Address,
  rpc: Pick<PublicClient, "readContract">,
  config: AttestConfig,
) {
  const envelope = await buildAuthorityRelayBatch(plans.map(({ plan }) => plan), multicall, rpc);
  const body = `        Relay[] memory relays = new Relay[](${plans.length});
        string[] memory rpcs = new string[](${plans.length});
${plans.map(({ plan, destinationRpcEnv }, i) => `${relayFields(plan, `relays[${i}]`)}        rpcs[${i}] = vm.envString("${rpcName(destinationRpcEnv)}");\n`).join("")}        _writeAuthorityRelayBatch(relays, rpcs, ${getAddress(multicall)}, "${outputPath}");
`;
  return scaffold(body, envelope, plans[0].plan.sourceBlock, config);
}
