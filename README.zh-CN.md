# Veritack

[English](README.md) | [简体中文](README.zh-CN.md)

**验证每次运行，守住工程航向。**

Veritack 是面向 coding agent 的极简证据与风险控制层。

它不替 Agent 决定如何工作。
它只确保每一次“完成”，都有与当前代码状态对应的有效证据。

默认工作流：

```
Orient → Change → Prove → Close
```

其余皆为扩展。

## 安装 (Pi)

```bash
pi install @veritack/pi-veritack
# 或本地 checkout：
pi install /absolute/path/to/veritack
pi install -l ./path/to/veritack
```

包名：`@veritack/pi-veritack`（Pi peer：`@earendil-works/pi-coding-agent` `>=0.80.0 <0.90.0`）。

在仓库内：

```
/veritack init
/veritack start fix redirect query loss after login
/veritack status
/veritack record incident Avatar cache | clear current-user query on logout
/veritack finish
```

Prompt 模板：

```
/veritack-fix user still sees old avatar after logout
```

## 状态

**v1.3.1** — 品牌换名为 Veritack + Provider Truth（语义用例、拒绝非执行检查模式）。

### 稳定面承诺

- 命令面：仅 `/veritack …`
- Provider API：`@veritack/pi-veritack/provider-api` + `apiVersion: 1` / `defineProvider`
- 独立包：`@veritack/postgres`、`@veritack/monorepo`、`@veritack/rust`
- Config：`policies` / 结构化或 `/regex/` CheckMatcher；普通子串 matcher 拒绝
- Closure：当前 revision 证据；`--waive` / `--abandon` 显式出口
- JSON / Why：`/veritack status --json` / `--why`
- 长 session：超阈值 compact RunState；`veritack/context` 默认摘要（`VERITACK_CONTEXT_AUDIT=full` 落全文）
- 包导出：仅 `./provider-api` 与 `./package.json`

```bash
npm run verify
npm run verify:dist
npm run smoke
npm run smoke -- --dist
npm run dogfood:adversarial
npm run dogfood:runtime
npm run dogfood:host -- --cwd . --profile veritack
```

## 配置要点

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
      "spec": "@veritack/postgres",
      "required": true,
      "priority": 100
    }
  ]
}
```

### 编写 Provider

只依赖正式入口 `@veritack/pi-veritack/provider-api`，禁止 `src/*` 内部导入。

```js
import { defineProvider } from '@veritack/pi-veritack/provider-api';

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

附带 `provider-cases.json`（checks 的 accept/reject，或 policies 的 expectTriggers）。

```bash
npx veritack-provider-test ./index.mjs --cases ./provider-cases.json
npm run check:providers
```

发布独立 Provider：推送 tag `provider-<name>-v<version>`（须等于该包 `package.json` version）。

### Matcher 迁移

普通子串 matcher 已拒绝。请改用 `/regex/` 或结构化 `CheckMatcher`。

- 成功修改工作区 → `revision+1`；`/veritack finish` 只接受当前 revision 证据
- `/veritack finish --waive "reason"` 显式承担风险
- Providers 仅可位于 `.veritack/providers/**`（或裸包名）；须 `/veritack trust <spec>` 后才加载
- `required` PolicyProvider 失效时阻断 mutation；optional 失败仅 warning + session 禁用
- `/veritack doctor` 只读诊断 config / trust / providers / run / env

## 开发

```bash
npm install
npm run verify
npm run smoke
```

详见 `NON_GOALS.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`。
