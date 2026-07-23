# @veritack/postgres

Veritack PolicyProvider for PostgreSQL migrations and destructive SQL.

## Capabilities

- `policies.inspect`
  - write/edit to `migrations/**` or `*.sql` → `databaseMigration`
  - read/grep/list of the same paths → no hit
  - destructive SQL in write content or shell → `databaseMigration` / `dangerousCommand`

## Install / trust

```bash
npm install ./veritack-postgres-1.1.0.tgz
# "providers": [{ "id": "postgres", "spec": "@veritack/postgres", "required": true }]
# /veritack trust @veritack/postgres
```

Depends only on the public `@veritack/pi-veritack/provider-api` contract (JSDoc types; runtime zero-deps).

## Certification checklist

- API compatible: `apiVersion: 1`; JSDoc types from `@veritack/pi-veritack/provider-api` only
- Trust-model compatible: self-contained single file; requires explicit `/veritack trust`
- Deterministic: same action/config → same hits
- Semantic cases: `provider-cases.json` policy expectTriggers
- Conformance: `npx veritack-provider-test index.mjs --cases provider-cases.json`

## Release

Tag format: `provider-postgres-v1.1.0` (must match `package.json` version).
