# Security Policy

## Reporting

If you discover a security issue in Skeg (especially around gate bypass, false-done closure, dangerous-command acknowledgement, or untrusted Provider execution), please open a private advisory or contact the maintainers. Do not file a public issue for exploitable bypasses until a fix is available.

## Scope

Skeg is a workflow control layer for coding agents. High-priority classes of bugs:

- Gate acknowledgement key collisions that skip confirmations
- Closure evaluator accepting stale or missing verification evidence
- Path traversal that writes outside the workspace or into `.git/`
- Silent config parse failure that disables protection policies
- Project-configured Providers executing without explicit user trust
- Run verification contracts weakened mid-run via config edits

## Provider trust boundary

Providers are JavaScript modules loaded via dynamic `import()`. Module top-level code runs with full Node.js privileges.

Threat model:

```text
User clones an unfamiliar repository
→ repository ships .skeg/config.json with providers[]
→ user opens the repo in Pi
→ Skeg session_start
→ without trust: Skeg must NOT import the module
```

Controls (v0.6.1+ / v1.0.2+):

- Project config may only request Providers; it cannot auto-execute them
- Workspace file Providers must live under `.skeg/providers/**` (no absolute paths, no `..`, no `file:` / `data:` URLs)
- Workspace Providers must be **self-contained single files** (no relative `import` / `require` / dynamic `import()` of helpers)
- Provider `capabilities` must exactly match exported implementations (unknown / duplicate / mismatch → reject load)
- Package Providers resolve from the project `node_modules` (not Skeg's install location); trust binds the resolved entry file content hash only (full package closure hashing is deferred)
- Trust records live outside the repo (`~/.skeg/trust.json`, overridable via `SKEG_USER_DIR`)
- Trust store writes are atomic (`trust.json.tmp` + rename; POSIX mode `0600`)
- Corrupt `trust.json` is backed up to `trust.json.corrupt-<timestamp>` with an error diagnostic (never silently wiped without notice)
- Each trust record binds `repoRealPath + spec + contentHash`; content changes invalidate trust
- Load uses `import(url?skeg=<contentHash>)` so reload picks up re-trusted content and narrows TOCTOU
- Explicit commands: `/skeg trust`, `/skeg untrust`, `/skeg providers`, `/skeg providers reload`, `/skeg doctor`
- Session freezes the loaded Provider set; config changes require explicit reload
- Provider runtime errors are surfaced and disable that Provider for the session (not silently ignored)
- `skeg-provider-test` runs conformance in a child process with a 10s timeout

Skeg does not sandbox Providers. Explicit trust + path limits + content hashing is the supported model for this release line.

## Check exit-status integrity

Bash check evidence uses the tool call's final exit status. Commands that may mask failure (`|| true`, `;`, pipes, background `&`, `exit 0`) are not recorded as check evidence. Nested wrappers (`bash -c`, `powershell -Command`, `cmd /c`) are unwrapped and their payloads inspected the same way.

## Control plane

Writes to `.skeg/config.json` and `.skeg/providers/**` always require confirm (`controlPlane` trigger). This cannot be disabled via project config.

## Run contract

`/skeg start` freezes required checks for the run. Mid-run config weakening does not reduce closure requirements; abandon and restart to adopt a new contract.

## Supported versions

Security fixes are released on the latest supported 1.x minor.
Critical fixes may be backported to the previous minor when practical.
