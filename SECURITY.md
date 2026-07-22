# Security Policy

## Reporting

If you discover a security issue in Skeg (especially around gate bypass, false-done closure, or dangerous-command acknowledgement), please open a private advisory or contact the maintainers. Do not file a public issue for exploitable bypasses until a fix is available.

## Scope

Skeg is a workflow control layer for coding agents. High-priority classes of bugs:

- Gate acknowledgement key collisions that skip confirmations
- Closure evaluator accepting stale or missing verification evidence
- Path traversal that writes outside the workspace or into `.git/`
- Silent config parse failure that disables protection policies

## Supported versions

Security fixes land on the latest 0.x release line.
