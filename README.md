# Veritack

[English](README.md) | [简体中文](README.zh-CN.md)

**Verify the run. Hold the course.**

Veritack is a minimal evidence and risk control layer for coding agents.

It does not tell the agent how to work.
It ensures that "done" is backed by current evidence.

The default workflow is:

```
Orient → Change → Prove → Close
```

Everything else is an extension.

## Install (Pi)

```bash
pi install @veritack/pi-veritack
# or, from a checkout:
pi install /absolute/path/to/veritack
pi install -l ./path/to/veritack
```

Package: `@veritack/pi-veritack` (Pi peer: `@earendil-works/pi-coding-agent` `>=0.80.0 <0.90.0`).

In a repo:

```
/veritack init
/veritack start fix redirect query loss after login
/veritack status
/veritack record incident Avatar cache | clear current-user query on logout
/veritack finish
```

Prompt template:

```
/veritack-fix user still sees old avatar after logout
```

## Status

**v1.3.1** — Brand rename to Veritack + Provider Truth (semantic cases, non-executing check rejection).

### Stability surface

- Command surface: `/veritack …` only
- Provider API: `@veritack/pi-veritack/provider-api` + `apiVersion: 1` / `defineProvider`
- Independent packages: `@veritack/postgres`, `@veritack/monorepo`, `@veritack/rust`
- Config: `policies` / structured or `/regex/` CheckMatcher; bare substring matchers rejected
- Closure: current-revision evidence; `--waive` / `--abandon` explicit exits
- JSON / Why: `/veritack status --json` / `--why`
- Long sessions: threshold compact of RunState; `veritack/context` summary by default (`VERITACK_CONTEXT_AUDIT=full` for full text)
- Package exports: only `./provider-api` and `./package.json`

```bash
npm run verify
npm run verify:dist
npm run smoke
npm run smoke -- --dist
npm run dogfood:adversarial
npm run dogfood:runtime
npm run dogfood:host -- --cwd . --profile veritack
```

## Config highlights

```json
{
  "guidance": "standard",
  "policies": {
    "dangerousCommand": { "risk": "guarded", "action": "confirm" },
    "dependencyChange": { "risk": "guarded", "action": "confirm" }
  },
  "checks": {
    "default": ["targeted-test", "diff"],
    "guarded": ["test", "typecheck", "lint", "diff"],
    "commands": {
      "test": { "kind": "package-script", "script": "test" },
      "unit-smoke": { "kind": "regex", "pattern": "/^make\\s+smoke(?:\\s|$)/i" }
    }
  },
  "providers": [
    {
      "id": "postgres",
      "spec": "@veritack/postgres",
      "required": true,
      "priority": 100
    }
  ]
}
```

### Writing a provider

Depend only on `@veritack/pi-veritack/provider-api`. Do not import `src/*`.

```js
import { defineProvider } from '@veritack/pi-veritack/provider-api';

export default defineProvider({
  apiVersion: 1,
  id: 'postgres',
  capabilities: ['policy', 'check'],
  policies: {
    inspect(action) {
      return [];
    },
  },
});
```

Ship a `provider-cases.json` with accept/reject (checks) or expectTriggers (policies).

```bash
npx veritack-provider-test ./index.mjs --cases ./provider-cases.json
npm run check:providers
```

Release an independent provider with tag `provider-<name>-v<version>` (must match that package's `package.json` version).

### Matcher migration

Bare substring matchers are rejected. Use `/regex/` or structured `CheckMatcher`:

```json
{
  "commands": {
    "unit-smoke": "/^make\\s+smoke(?:\\s|$)/i",
    "test": { "kind": "package-script", "script": "test" },
    "cargo-test": { "kind": "argv", "executable": "cargo", "args": ["test"] }
  }
}
```

- Workspace mutation → `revision+1`; `/veritack finish` accepts only current-revision evidence
- `/veritack finish --waive "reason"` is an explicit risk acceptance
- Providers must live under `.veritack/providers/**` or be a bare package name; load only after `/veritack trust <spec>`
- `required` PolicyProvider failure blocks mutation; optional failure is warning + session disable
- `/veritack doctor` is a read-only diagnosis of config / trust / providers / run / env

## Develop

```bash
npm install
npm run verify
npm run smoke
```

See `NON_GOALS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`.
