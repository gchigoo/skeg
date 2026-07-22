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

Package name: `@gchigoo/skeg` (Pi peer: `@earendil-works/pi-coding-agent` `>=0.80.0 <0.90.0`).

In a repo:

```
/skeg init
/skeg start fix redirect query loss after login
/skeg status
/skeg record incident Avatar cache | clear current-user query on logout
/skeg finish
```

Flat aliases (`/init` `/run` `/status` `/finish` `/record`) remain for compatibility but emit a deprecation notice (prefer `/skeg …`).

Prompt template:

```
/skeg-fix user still sees old avatar after logout
```

(`/fix` still works.)

## Status

**v0.6.0** — Extension Contract：`PolicyProvider` / `CheckProvider` / `RecordSelector`、结构化 `CheckMatcher`、扁平命令弃用提示；在 v0.5.1 假绿封口之上对外开放扩展点。

```bash
npm run verify
npm run smoke
npm run dogfood:adversarial
npm run dogfood:runtime
npm run dogfood:host -- --cwd . --profile skeg
```

## Config highlights

```json
{
  "guidance": "standard",
  "policies": {
    "dangerousCommand": { "risk": "guarded", "action": "confirm" },
    "dependencyChange": { "risk": "guarded", "action": "confirm" }
  },
  "checks": {
    "default": ["targeted-test", "diff"],
    "guarded": ["test", "typecheck", "lint", "diff"],
    "commands": {
      "test": { "kind": "package-script", "script": "test" },
      "unit-smoke": { "kind": "regex", "pattern": "/^make\\s+smoke(?:\\s|$)/i" }
    }
  },
  "providers": ["./skeg-providers/my-policy.mjs"]
}
```

- 成功修改工作区 → `revision+1`，旧 checks 变 stale；`/finish` 只接受当前 revision 证据
- `/skeg finish --waive "reason"` 显式承担风险
- `cat migrations/*.sql` 为 read，不记变更、不弹 gate
- Providers 可追加 Policy / Check / Record；不能增加新的核心阶段状态机（见 `NON_GOALS.md`）

## Develop

```bash
npm install
npm run verify    # test + typecheck + budgets + adversarial + dogfood
npm run smoke     # Pi 实机抽测（需本机已装 pi）
```

See `NON_GOALS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`.
