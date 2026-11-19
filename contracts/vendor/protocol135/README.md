Protocol PR #135 compatibility snapshot, MIT licensed, pinned by `manifest.json` to
protocol revision `3169f8cb72721330ec0af7b0235eeaf6877b9c74`. That commit is the tip of the open
#135 branch (`feat/signed-dispatch-108`), not a merge commit; re-pin to the merge commit once
#135 lands, and drop the snapshot once a protocol package contains these interfaces.
Only import specifiers are rewritten to make these sources self contained; `manifest.json`
records the SHA-256 of each unmodified protocol source and of each vendored file. The published
`@crossecute/protocol@0.1.0` predates signed dispatch; these small interfaces, types, and
hashing helpers let the SDK work from a clean install until a protocol package containing #135
is released. No transmitter or receiver deployment code is vendored.

Refresh with `python3 scripts/sync-protocol135.py /path/to/protocol` after building the EVM
and guard Forge profiles (`contracts/evm/out`, `contracts/safe-guard/out`) at the revision set
in that script. The script is the one place the revision is written: it generates the
manifest, `ts/src/signedAbi.ts` (ABI exports and `PROTOCOL_135_REVISION`),
`vectors/authority.json`, and `vectors/lzoft-protocol.json`, the LayerZero OFT options attribute selector and
the `Proxy` initcode hash that protocol's artifacts and sources give, which the OFT builders' constants are
tested against. The larger ABIs keep only the functions and events listed in `MEMBERS`
in the script, plus all custom errors; add a name there to export it. The script fails if a listed
name is absent from the protocol artifact. `--check` regenerates in memory and fails on any difference. CI runs it in the `protocol-pin` job,
which checks out `crossecute/protocol` at the manifest revision and builds both profiles
(`forge build src` in `contracts/evm` and `contracts/safe-guard`). To run it locally:

```bash
git -C /path/to/protocol checkout "$(jq -r .revision contracts/vendor/protocol135/manifest.json)"
(cd /path/to/protocol/contracts/evm && forge build src)
(cd /path/to/protocol/contracts/safe-guard && forge build src)
python3 scripts/sync-protocol135.py --check /path/to/protocol
```

Update the pin deliberately when adopting a new protocol revision, and update the revision
link in the root README; replace this snapshot with package imports after publication.
