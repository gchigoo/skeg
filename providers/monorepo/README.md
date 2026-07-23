# @veritack/monorepo

Veritack CheckProvider for workspace-scoped test commands in monorepos.

## Capabilities

- `checks.classify`
  - `pnpm|yarn --filter <pkg> test` → `test`
  - `turbo run test --filter=<pkg>` → `test`
  - `nx test <project>` → `test`
- Rejects non-executing modes: `--dry-run`, `--dry=json`, `--help`, `--listTests`, `--list`

## Install / trust

```bash
npm install ./veritack-monorepo-1.1.0.tgz
# "providers": [{ "id": "monorepo", "spec": "@veritack/monorepo" }]
# /veritack trust @veritack/monorepo
```

Depends only on the public `@veritack/pi-veritack/provider-api` contract (JSDoc types; runtime zero-deps).

## Certification checklist

- API compatible: `apiVersion: 1`; JSDoc types from `@veritack/pi-veritack/provider-api` only
- Trust-model compatible: self-contained single file; requires explicit `/veritack trust`
- Deterministic: same command/config → same classification or null
- Semantic cases: `provider-cases.json` accept/reject
- Conformance: `npx veritack-provider-test index.mjs --cases provider-cases.json`

## Release

Tag format: `provider-monorepo-v1.1.0` (must match `package.json` version).
