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

**v0.3.2 ready** — 扩大真实使用面：4 新宿主 profile + abandon/protected/auth 场景；`hasCliFlag` 修复 `--force`/`--abandon`；有机 run ≥ 12。

```bash
npm run verify
npm run smoke
npm run dogfood:host -- --cwd . --profile skeg
npm run dogfood:host -- --cwd /path/to/real-project --profile Blog
node dogfood/organic-runs.mjs --cwd /path/to/project --name <label>
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
npm run dogfood:host -- --cwd /path/to/real-project --profile <name>
```

Design notes (`DESIGN.md` / `NON_GOALS.md` / `CHANGELOG.md`) and dogfood reports stay local (gitignored).
