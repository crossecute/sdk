Protocol PR #135 compatibility snapshot, MIT licensed, pinned by `manifest.json` to
protocol revision `3169f8cb72721330ec0af7b0235eeaf6877b9c74`.
Only import specifiers are rewritten to make these sources self contained; `manifest.json`
records the SHA-256 of each unmodified protocol source and of each vendored file. The published
`@crossecute/protocol@0.1.0` predates signed dispatch; these small interfaces, types, and
hashing helpers let the SDK work from a clean install until a protocol package containing #135
is released. No transmitter or receiver deployment code is vendored.

Refresh with `python3 scripts/sync-protocol135.py /path/to/protocol` after building the EVM
and guard Forge profiles (`contracts/evm/out`, `contracts/safe-guard/out`) at the revision set
in that script. The script is the one place the revision is written: it generates the
manifest, `ts/src/signedAbi.ts` (ABI exports and `PROTOCOL_135_REVISION`) and
`vectors/authority.json`. `--check` regenerates in memory and fails on any difference.
Update the pin deliberately when adopting a new protocol revision, and update the revision
link in the root README; replace this snapshot with package imports after publication.
