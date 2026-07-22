# skeg-provider-postgres

Skeg PolicyProvider for PostgreSQL migrations and destructive SQL.

## Capabilities

- `policies.inspect`
  - Gate writes under `migrations/**` or `*.sql`
  - Detect destructive SQL in file content or bash: `DROP TABLE`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER ... DROP COLUMN`

## Install / trust

```bash
npm install ./skeg-provider-postgres-0.1.0.tgz
# in .skeg/config.json:
# "providers": [{ "id": "postgres", "spec": "skeg-provider-postgres", "required": true }]
# then: /skeg trust skeg-provider-postgres
```

Depends only on the public `@gchigoo/skeg/provider-api` contract (JSDoc types; runtime zero-deps).
