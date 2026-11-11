Protocol PR #135 compatibility snapshot, MIT licensed, pinned by `manifest.json`.
Only import specifiers are rewritten to make these sources self contained. The
published `@crossecute/protocol@0.1.0` predates signed dispatch; these small interfaces,
types, and hashing helpers let the SDK work from a clean install until a protocol
package containing #135 is released. No transmitter or receiver deployment code is
vendored. Refresh with `python3 scripts/sync-protocol135.py /path/to/protocol` after
building both its EVM and guard profiles at the pinned revision. Generated TS ABIs
come from those Forge artifacts. Update the pin deliberately when adopting a new
protocol revision; replace this snapshot with package imports after publication.
