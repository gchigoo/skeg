# skeg-provider-postgres

Skeg PolicyProvider for PostgreSQL migrations and destructive SQL.

## Capabilities

- `policies.inspect`
  - Gate writes under `migrations/**` or `*.sql`
  - Detect destructive SQL in file content or bash: `DROP TABLE`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER ... DROP COLUMN`

## Install / trust

```bash
npm install ./skeg-provider-postgres-1.0.0.tgz
# in .skeg/config.json:
# "providers": [{ "id": "postgres", "spec": "skeg-provider-postgres", "required": true }]
# then: /skeg trust skeg-provider-postgres
```

Depends only on the public `@gchigoo/skeg/provider-api` contract (JSDoc types; runtime zero-deps).

## Certification checklist

- API compatible: `apiVersion: 1`; JSDoc types from `@gchigoo/skeg/provider-api` only
- Trust-model compatible: self-contained single file; requires explicit `/skeg trust`
- Deterministic: same action/config → same RiskHit set
- No malformed output: host validates hits; invalid entries discarded with diagnostics
- Conformance passed: `npx skeg-provider-test index.mjs` (or repo `npm run check:providers`)
- Package integrity: GitHub Release attaches tarball + `SHA256SUMS.txt`

## Release

Tag format: `skeg-provider-postgres-v1.0.0` (must match `package.json` version).
