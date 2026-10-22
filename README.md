# dsh-modeltrace

Background model-fingerprint verification for DSH.

## What it does

ModelTrace verifies that the model answering your turns is the one you expect,
using a numeric fingerprint bank instead of prompts. It can run on a schedule or
on demand, and renders results in the conversation, an optional floating HUD, or
a CLI command.

Features:

- Fingerprint bank (`assets/unified_bank.json`) built from robust numeric probes.
- Scheduled background checks (cadence configurable).
- Gate mode: block or warn when the fingerprint does not match.
- Optional HUD overlay and a `modeltrace` command.
- Minimal-session mode for low-overhead runs.

## Configuration

See `lib/config.js` for the full option list. Typical setup:

```yaml
- id: dsh-modeltrace
  config:
    cadenceMinutes: 60
    gate: warn
    hud: false
```

## Commands

- `modeltrace status` — current verdict and last check
- `modeltrace verify` — run a check now
- `modeltrace report` — print the latest report

## Testing

```bash
node test/plugin-load.mjs
node test/scorer-regression.mjs
```

## License

MIT
