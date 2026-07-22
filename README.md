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

**v0.7.0** — Ecosystem Proof：三个只依赖公共 API 的真实 Provider 示例、`npm pack` 干净沙箱端到端、普通子串 CheckMatcher 拒绝。

```bash
npm run verify
npm run verify:dist   # verify + pack dry-run + dogfood/dist-e2e
npm run smoke
npm run smoke -- --dist   # 手动：Pi 从沙箱 node_modules 装载 tarball（需模型 API）
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
  "providers": [
    {
      "id": "postgres",
      "spec": ".skeg/providers/postgres.mjs",
      "required": true,
      "priority": 100
    }
  ]
}
```

### Writing a provider

只依赖 `@gchigoo/skeg/provider-api`，禁止 `src/*` 内部导入。示例见 `examples/providers/`（postgres / monorepo / rust；零运行时依赖的 `.mjs`）。

```js
import { defineProvider } from '@gchigoo/skeg/provider-api';

export default defineProvider({
  apiVersion: 1,
  id: 'postgres',
  capabilities: ['policy', 'check'],
  policies: {
    inspect(action) {
      return [];
    },
  },
});
```

```bash
npx skeg-provider-test .skeg/providers/postgres.mjs
# 或仓库内示例：
npm run check:providers
```

### Matcher migration (v0.7)

普通子串 matcher 已拒绝（配置诊断 `error` 并忽略该条目）。请改用 `/regex/` 或结构化 `CheckMatcher`：

```json
{
  "commands": {
    "unit-smoke": "/^make\\s+smoke(?:\\s|$)/i",
    "test": { "kind": "package-script", "script": "test" },
    "cargo-test": { "kind": "argv", "executable": "cargo", "args": ["test"] }
  }
}
```

- 成功修改工作区 → `revision+1`，旧 checks 变 stale；`/finish` 只接受当前 revision 证据
- `/skeg finish --waive "reason"` 显式承担风险
- `cat migrations/*.sql` 为 read，不记变更、不弹 gate
- Providers 仅可位于 `.skeg/providers/**`（或裸包名）；须 `/skeg trust <spec>` 后才加载；内容变更后信任失效
- `/skeg providers` / `trust` / `untrust` / `providers reload` 管理扩展信任
- `required` PolicyProvider 失效时阻断 mutation；optional 失败仅 warning + session 禁用
- `/skeg status` 展示 check/gate 的 `provider:<id>` provenance
- `pnpm test || true` 等掩盖退出码的命令不记为 check 证据
- Providers 可追加 Policy / Check / Record；不能增加新的核心阶段状态机（见 `NON_GOALS.md`）

## Develop

```bash
npm install
npm run verify    # test + typecheck + budgets + adversarial + dogfood
npm run smoke     # Pi 实机抽测（需本机已装 pi）
```

See `NON_GOALS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`.
