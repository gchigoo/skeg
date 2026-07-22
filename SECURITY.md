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

Controls (v0.6.1+):

- Project config may only request Providers; it cannot auto-execute them
- Workspace file Providers must live under `.skeg/providers/**` (no absolute paths, no `..`, no `file:` / `data:` URLs)
- Package Providers resolve from the project `node_modules` (not Skeg's install location)
- Trust records live outside the repo (`~/.skeg/trust.json`, overridable via `SKEG_USER_DIR`)
- Each trust record binds `repoRealPath + spec + contentHash`; content changes invalidate trust
- Explicit commands: `/skeg trust`, `/skeg untrust`, `/skeg providers`, `/skeg providers reload`
- Session freezes the loaded Provider set; config changes require explicit reload
- Provider runtime errors are surfaced and disable that Provider for the session (not silently ignored)

Skeg does not sandbox Providers. Explicit trust + path limits + content hashing is the supported model for this release line.

## Check exit-status integrity

Bash check evidence uses the tool call's final exit status. Commands that may mask failure (`|| true`, `;`, pipes, background `&`, `exit 0`) are not recorded as check evidence.

## Supported versions

Security fixes land on the latest 0.x release line.
