# skeg-provider-rust

Skeg CheckProvider for Rust/cargo verification commands.

## Capabilities

- `checks.classify`
  - `cargo test` / `cargo nextest run` → `test`
  - `cargo clippy` → `lint`
  - `cargo fmt --check` / `cargo fmt -- --check` → `fmt`

## Install / trust

```bash
npm install ./skeg-provider-rust-0.1.0.tgz
# "providers": [{ "id": "rust", "spec": "skeg-provider-rust" }]
# /skeg trust skeg-provider-rust
```
