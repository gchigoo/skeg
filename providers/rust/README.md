# @veritack/rust

Veritack CheckProvider for Rust/cargo verification commands.

## Capabilities

- `checks.classify`
  - `cargo test` / `cargo nextest run` → `test`
  - `cargo clippy` → `lint`
  - `cargo fmt --check` / `cargo fmt -- --check` → `fmt`
- Rejects non-executing modes: `cargo test --no-run`, `cargo test -- --list`, `cargo nextest list|archive`

## Install / trust

```bash
npm install ./veritack-rust-1.1.0.tgz
# "providers": [{ "id": "rust", "spec": "@veritack/rust" }]
# /veritack trust @veritack/rust
```

Depends only on the public `@veritack/pi-veritack/provider-api` contract (JSDoc types; runtime zero-deps).

## Certification checklist

- API compatible: `apiVersion: 1`; JSDoc types from `@veritack/pi-veritack/provider-api` only
- Trust-model compatible: self-contained single file; requires explicit `/veritack trust`
- Deterministic: same command/config → same classification or null
- Semantic cases: `provider-cases.json` accept/reject
- Conformance: `npx veritack-provider-test index.mjs --cases provider-cases.json`

## Release

Tag format: `provider-rust-v1.1.0` (must match `package.json` version).
