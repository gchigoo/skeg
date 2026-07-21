# Skeg

Stay light. Hold course.

Skeg is a minimal engineering workflow for coding agents.

It does not tell the agent how to work.
It tracks intent, enforces critical boundaries, collects verification
evidence, and preserves only the decisions worth keeping.

The default workflow is:

```
Orient → Change → Prove → Close
```

Everything else is an extension.

## Install (Pi)

```bash
pi install /absolute/path/to/skeg
# or, from a project:
pi install -l ./path/to/skeg
```

In a repo:

```
/init
/run fix redirect query loss after login
/status
/record incident Avatar cache | clear current-user query on logout
/finish
```

Prompt template:

```
/fix user still sees old avatar after logout
```

## Status

**v0.3.0 ready** — Record 回读；ado-bug-agent 宿主 dogfood 10/10 PASS；摩擦驱动修复（绝对路径 risk、`node --test` 记账）。

```bash
npm run verify
npm run smoke
npm run dogfood:host -- --cwd /path/to/real-project
```

## Config highlights

```json
{
  "guidance": "standard",
  "checks": {
    "default": ["targeted-test", "diff"],
    "guarded": ["test", "typecheck", "lint", "diff"],
    "commands": { "unit-smoke": "make smoke" }
  }
}
```

- bash `pnpm test src/foo.test.ts` → 自动记 `targeted-test`
- `guidance: "compact"` → 注入仅状态行

## Develop

```bash
npm install
npm run verify    # test + typecheck + budgets + dogfood
npm run smoke     # Pi 实机抽测（需本机已装 pi）
npm run dogfood:host -- --cwd /path/to/real-project
```

Design notes (`DESIGN.md` / `NON_GOALS.md` / `CHANGELOG.md`) and dogfood reports stay local (gitignored).
