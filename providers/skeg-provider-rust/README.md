# skeg-provider-rust

Skeg CheckProvider for Rust/cargo verification commands.

## Capabilities

- `checks.classify`
  - `cargo test` / `cargo nextest run` → `test`
  - `cargo clippy` → `lint`
  - `cargo fmt --check` / `cargo fmt -- --check` → `fmt`

## Install / trust

```bash
npm install ./skeg-provider-rust-1.0.0.tgz
# "providers": [{ "id": "rust", "spec": "skeg-provider-rust" }]
# /skeg trust skeg-provider-rust
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

Tag format: `skeg-provider-rust-v1.0.0` (must match `package.json` version).
