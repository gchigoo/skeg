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

**v0.3.3 ready** — 稳定性收束：host dogfood 唯一 marker 覆盖 protected/auth；`--dump-events`/`--repeat`；`node --experimental-strip-types --test` 启发式；同模型 3×13/13 + 跨模型 13/13。

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
