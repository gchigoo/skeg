# skeg-provider-monorepo

Skeg CheckProvider for workspace-scoped test commands in monorepos.

## Capabilities

- `checks.classify`
  - `pnpm --filter <pkg> test` / `yarn --filter <pkg> test`
  - `turbo run test --filter=<pkg>`
  - `nx test <project>`

Classifies matches as check name `test`.

## Install / trust

```bash
npm install ./skeg-provider-monorepo-1.0.0.tgz
# "providers": [{ "id": "monorepo", "spec": "skeg-provider-monorepo" }]
# /skeg trust skeg-provider-monorepo
```

Depends only on the public `@gchigoo/skeg/provider-api` contract (JSDoc types; runtime zero-deps).

## Certification checklist

- API compatible: `apiVersion: 1`; JSDoc types from `@gchigoo/skeg/provider-api` only
- Trust-model compatible: self-contained single file; requires explicit `/skeg trust`
- Deterministic: same command/config → same classification or null
- No malformed output: host validates ClassifiedCheck; invalid returns discarded
- Conformance passed: `npx skeg-provider-test index.mjs` (or repo `npm run check:providers`)
- Package integrity: GitHub Release attaches tarball + `SHA256SUMS.txt`

## Release

Tag format: `skeg-provider-monorepo-v1.0.0` (must match `package.json` version).
