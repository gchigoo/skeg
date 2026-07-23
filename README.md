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

Prompt template:

```
/skeg-fix user still sees old avatar after logout
```

### Compat opt-in (flat commands)

v1.0 起默认只注册 `/skeg`。扁平 `/init` `/run` `/status` `/finish` `/record` 仍随包分发，需手动启用其一：

```json
{
  "packages": ["@gchigoo/skeg"],
  "extensions": [
    "./node_modules/@gchigoo/skeg/extensions/compat.ts"
  ]
}
```

或 packages 对象形式显式列出：

```json
{
  "packages": [
    {
      "source": "./node_modules/@gchigoo/skeg",
      "extensions": ["./extensions/core.ts", "./extensions/compat.ts"]
    }
  ]
}
```

## Status

**v1.1.0** — Public API and Supply Chain：编译后的 Provider API 入口、只读公共 DTO、`/skeg status --json`、tag-driven release 与 Pi 兼容矩阵。

### 稳定面承诺

- 命令面：`/skeg init|start|status|finish|record|trust|untrust|providers|doctor…`
- Provider：编译入口 `@gchigoo/skeg/provider-api`（`dist/provider-api.js` + `.d.ts`）+ `apiVersion: 1` / `defineProvider`
- Config：`policies` / 结构化或 `/regex/` CheckMatcher；普通子串 matcher 拒绝
- Closure：当前 revision 证据；`--waive` / `--abandon` 显式出口
- JSON：`/skeg status --json` 输出 Evidence Report V1（不写仓库文件）
- 包导出：`./provider-api` 与 `./package.json` 为正式面；通配 `./*` **deprecated**，计划 v1.3 移除

```bash
npm run verify
npm run verify:dist   # verify + pack dry-run + dogfood/dist-e2e
npm run smoke         # 实机：/skeg 剧本（需模型 API）
npm run smoke -- --dist
npm run dogfood:adversarial
npm run dogfood:runtime
npm run dogfood:host -- --cwd . --profile skeg
```

Smoke 剧本：lean1 编辑后跑 `npm test -- <path>` 再 `/skeg finish`；lean2 无证据须被拒绝并用 `--abandon` 清场；risk gate 后 `/skeg finish --waive`。注入经 `skeg/context` 审计 entry 可观测。

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

只依赖正式入口 `@gchigoo/skeg/provider-api`（编译产物，自包含只读 V1 DTO），禁止 `src/*` 内部导入。示例见 `examples/providers/`（postgres / monorepo / rust；零运行时依赖的 `.mjs`）。

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

本地开发可先 `npm run build` 生成 `dist/`，再按包导出解析类型与运行时。

```bash
npx skeg-provider-test .skeg/providers/postgres.mjs
# 或仓库内示例：
npm run check:providers
```

### Matcher migration

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

- 成功修改工作区 → `revision+1`，旧 checks 变 stale；`/skeg finish` 只接受当前 revision 证据
- `/skeg finish --waive "reason"` 显式承担风险
- `cat migrations/*.sql` 为 read，不记变更、不弹 gate
- Providers 仅可位于 `.skeg/providers/**`（或裸包名）；须 `/skeg trust <spec>` 后才加载；内容变更后信任失效
- `/skeg providers` / `trust` / `untrust` / `providers reload` 管理扩展信任
- `required` PolicyProvider 失效时阻断 mutation；optional 失败仅 warning + session 禁用
- `/skeg status` 展示 check/gate 的 `provider:<id>` provenance；`/skeg status --json` 输出稳定 Evidence Report
- `/skeg doctor` 只读诊断 config / trust / providers / run / env
- `pnpm test || true` 等掩盖退出码的命令不记为 check 证据
- Providers 可追加 Policy / Check / Record；不能增加新的核心阶段状态机（见 `NON_GOALS.md`）

## Develop

```bash
npm install
npm run verify    # test + typecheck + budgets + adversarial + dogfood
npm run smoke     # Pi 实机抽测（需本机已装 pi）
```

See `NON_GOALS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`.
