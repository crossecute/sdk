#!/usr/bin/env bash
# Runs Forge Attest's own safe-eip712 reader and hash derivation over the typed data
# test/SafeTx.t.sol writes, and checks the safeTxHash matches the SDK's. Run after `forge test`.
# Needs git, jq, cast and network access to clone Forge Attest.
set -euo pipefail

# v1.4.0.
commit=9e76385ac2f96f171ceb9391cf9e8298e2d408cf
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" fetch -q --depth 1 https://github.com/crossecute/forge-attest "$commit"
git -C "$work" checkout -q FETCH_HEAD

bash "$work/lib/normalize.sh" --input "$root/out/test-safe-tx.json" --format safe-eip712 >"$work/canonical.json"
theirs="$(bash "$work/lib/derive.sh" "$work/canonical.json" | sed -n 's/^SAFE_TX_HASH=//p')"
ours="$(cat "$root/out/test-safe-tx-hash.txt")"
if [[ "$theirs" != "$ours" ]]; then
  echo "Forge Attest derives $theirs, the SDK $ours" >&2
  exit 1
fi
echo "Forge Attest reads the SDK's typed data and derives the same safeTxHash: $ours"
