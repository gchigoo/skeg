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
npm install ./skeg-provider-monorepo-0.1.0.tgz
# "providers": [{ "id": "monorepo", "spec": "skeg-provider-monorepo" }]
# /skeg trust skeg-provider-monorepo
```
