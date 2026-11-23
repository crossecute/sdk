#!/usr/bin/env bash
# Exercise the SDK tarball with its exact protocol dependency in a fresh project.
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

version="$(node -p 'require("./package.json").dependencies["@crossecute/protocol"]')"
oz="$(node -p 'require("./package.json").peerDependencies["@openzeppelin/contracts"]')"
viem="$(node -p 'require("./package.json").devDependencies.viem')"
sdk_tarball="$(npm pack --json --pack-destination "$work" |
  node -p 'JSON.parse(require("node:fs").readFileSync(0))[0].filename')"
# A local tarball can represent a release candidate before the registry publishes it.
protocol="${1:-@crossecute/protocol@$version}"

cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts --loglevel=error "./$sdk_tarball" "$protocol" \
  "@openzeppelin/contracts@$oz" "@openzeppelin/contracts-upgradeable@$oz" "viem@$viem"

node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeFunctionData, zeroHash } from "viem";
import { ISignedTransmitterAbi } from "@crossecute/protocol/abi";
import { PROTOCOL_VERSION, registerRootCalldata, signedTransmitterAbi } from "@crossecute/sdk";

const pkg = (name) => JSON.parse(readFileSync(`node_modules/@crossecute/${name}/package.json`, "utf8"));
assert.equal(pkg("sdk").dependencies["@crossecute/protocol"], PROTOCOL_VERSION);
assert.equal(pkg("protocol").version, PROTOCOL_VERSION);
assert.deepEqual(
  signedTransmitterAbi.find(({ name }) => name === "quoteMessageSigned"),
  ISignedTransmitterAbi.find(({ name }) => name === "quoteMessageSigned"),
);
assert.ok(signedTransmitterAbi.some(({ name }) => name === "quoteMessageSigned"));
assert.equal(registerRootCalldata(zeroHash), encodeFunctionData({
  abi: ISignedTransmitterAbi, functionName: "registerRoot", args: [zeroHash],
}));
JS

git init -q
mkdir test
cat > test/Consumer.t.sol <<'SOLIDITY'
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISignedTransmitter} from "@crossecute/protocol/messaging/outbound/ISignedTransmitter.sol";
import {SignedDispatch} from "@crossecute/sdk/SignedDispatch.sol";

contract ConsumerTest {
    function testRegisterRootCalldataMatchesProtocol() public pure {
        bytes32 root = keccak256("consumer");
        require(
            keccak256(SignedDispatch.registerRootCalldata(root))
                == keccak256(abi.encodeCall(ISignedTransmitter.registerRoot, (root)))
        );
    }
}
SOLIDITY
cat > foundry.toml <<'TOML'
[profile.default]
libs = ["node_modules"]
solc_version = "0.8.28"
remappings = [
    "@crossecute/protocol/=node_modules/@crossecute/protocol/contracts/",
    "@crossecute/sdk/=node_modules/@crossecute/sdk/contracts/",
    "@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/",
    "@openzeppelin/contracts-upgradeable/=node_modules/@openzeppelin/contracts-upgradeable/",
]
TOML
forge test
