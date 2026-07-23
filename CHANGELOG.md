# Changelog

## 1.1.0 — 2026-07-23

Public API and Supply Chain：正式 Provider 入口、只读公共 DTO、JSON 证据报告、发布供应链与 Pi 兼容矩阵。

### Added
- 自包含只读 V1 DTO（`ProviderActionV1` / `ProviderConfigV1` / `ProviderRiskHitV1` 等）；`provider-api` 零 import
- `deepFreezeCopy` / `frozenConfigView`：Policy / Check / Record 调用点传冻结副本
- `tsc` 编译入口：`dist/provider-api.js` + `dist/provider-api.d.ts`（`npm run build` / `prepack`）
- `/skeg status --json` → Evidence Report V1（`schemaVersion: 1`）
- `.github/workflows/release.yml`：tag=version 校验、verify、checksums、SPDX SBOM、GitHub Release、可选 npm provenance
- CI `pi-compat` 矩阵（Pi `0.80.1` / lockfile / latest-0.8x）+ 每周定时 smoke

### Changed
- `exports["./provider-api"]` 指向 `dist/`；新增 `exports["./package.json"]`
- 通配 `exports["./*"]` 标记 deprecated（计划 v1.3 移除）
- 旧导出名 `RiskHit` / `ClassifiedCheck` / `RecordIndexEntry` / `ProviderAction` 为 V1 DTO 类型别名（apiVersion 仍为 1）

## 1.0.2 — 2026-07-23

Operational Hardening：信任存储、capability 契约、conformance 隔离与诊断。

### Added
- `/skeg doctor`：config / trust / providers / run / env 只读诊断
- trust store 原子写（`trust.json.tmp` + rename，POSIX `0600`）与损坏备份诊断
- Provider capability 与导出严格一致（未知 / 重复 / 声明↔实现不一致 → 拒载）
- `skeg-provider-test` 子进程隔离 + 10s 超时
- 冻结 v1/v2 RunState migration fixtures

### Changed
- 命令面预算 `COMMAND_CASE_MAX` 9 → 10（为 doctor 有意扩面）

## 1.0.1 — 2026-07-22

Contract Integrity：冻结 Run 验证契约，封死路径/信任/假证据缺口。

### Added
- `RunContract`：`/skeg start` 冻结 `defaultChecks` / `guardedChecks` 与配置 hash；closure / inject 优先用契约基线
- `controlPlane` trigger：硬编码 confirm `.skeg/config.json` 与 `.skeg/providers/**`（配置不可关闭）
- mutation / Provider 路径改用 `realpath`（含 Windows junction）
- workspace Provider 必须自包含单文件；`import(?skeg=<hash>)` 绑定内容并修复 reload 缓存
- shell wrapper unwrap：`bash/sh/zsh -c`、`powershell -Command`、`cmd /c` 递归退出码完整性检查
- 多维预算：`extensions` 总 LOC、`INJECT_TOKEN_BUDGET`、命令面、`SkegEvent` 变体数

### Fixed
- ConfigDriftBypass：运行中弱化 `checks.guarded` 不再能让 finish 假绿
- NestedShellFalseEvidence：`bash -c 'pnpm test path || true'` 不再记为 targeted-test 证据
- ProviderReloadStale：重新 trust 后 reload 加载新模块
- dispatch 队列异常不再毒化后续状态更新
- SECURITY.md 支持线从 0.x 更正为 1.x

## 1.0.0 — 2026-07-22

Stable Surface。默认只注册 `/skeg`；清理 legacy 兼容面。

### Breaking
- `pi.extensions` 默认不再加载 `extensions/compat.ts`（扁平 `/init` `/run` `/status` `/finish` `/record` 需 opt-in）
- Provider 必须 `apiVersion: 1`（`defineProvider`）；无 apiVersion 的旧模块拒绝加载
- `riskTriggers` 不再映射进 policies（仅 warning：改用 `policies`）
- 删除 `prompts/fix.md`（保留 `/skeg-fix`）

### Changed
- 实机 smoke / host-dogfood 剧本切换到 `/skeg …` 命令面
- smoke 断言默认下扁平 `/run` 不注册

## 0.9.0 — 2026-07-22

Real-host Green：实机 smoke 剧本对齐 closure / 注入语义，源码与 `--dist` 双 PASS。

### Added
- `skeg/context` 审计 entry：`before_agent_start` 注入内容 hash 变化时落盘（不进 LLM；供 smoke/host 观测）
- pi-smoke lean1：真实 `npm test -- <path>` → targeted-test 证据 → `/finish` 真关闭
- pi-smoke lean2：无证据 `/finish` 拒绝（false-green）后 `/finish --abandon` 清场
- pi-smoke risk：`/finish --waive` 关闭并断言 Waivers 报告

### Fixed
- smoke/host 断言从过时的 `Records (.skeg/records/)` / `custom_message` 改为 `Records (relevant)` + `skeg/context` entry
- slash 命令 harness：`waitNotifyQuiet` 避免 notify 落到下一轮断言（`/status` 竞态）

## 0.8.0 — 2026-07-22

Compat Split + CI 硬化。

### Added
- `extensions/compat.ts`：扁平 `/init` `/run` `/status` `/finish` `/record`（默认仍在 `pi.extensions`；v1.0 将移除）
- `src/hostsession.ts`：core / compat 共享 gate acknowledgement 与 pending mutations
- CI：`check:providers`、`dogfood`、`dogfood:dist`（三平台 × Node 22/24）
- `dogfood/npm-cli.mjs`：跨平台 npm 解析（`npm_execpath` → Windows/POSIX 布局 → 裸 `npm`）

### Changed
- `extensions/core.ts` 只注册 `/skeg`；事件钩子从 session entries 同步 RunState（兼容 compat 写入）
- 删除 `CheckResult` 别名、`resolveProviderSpec`；`SkegConfig.riskTriggers` 字段移除（加载仍兼容旧 JSON 并告警）

## 0.7.0 — 2026-07-22

Ecosystem Proof.

### Added
- `examples/providers/`：`skeg-provider-postgres` / `monorepo` / `rust`（只依赖公共契约，运行时零依赖 `.mjs`）
- `dogfood/dist-e2e.mjs` + `npm run dogfood:dist`：`npm pack` tarball → 干净沙箱安装 Provider → trust → 第三方 policy/check → finish closure
- `npm run check:providers`：对示例 Provider 跑 `skeg-provider-test` conformance
- `pi-smoke --dist`：Pi 从沙箱 `node_modules` 装载安装后的 skeg tarball（手动，需模型 API）
- 预算脚本检查示例 Provider 不得 import 内部 `src/*`

### Changed
- **Breaking**：普通子串 CheckMatcher 拒绝（`error` 诊断并忽略该 matcher）；仅 `/regex/` 或结构化 matcher
- `CHECK_RECORDED` 保留 `source`，`/skeg status` 能展示第三方 check provenance
- `verify` 纳入 `check:providers`；`verify:dist` 纳入 `dogfood:dist`

## 0.6.2 — 2026-07-22

Provider API Hardening.

### Added
- 公共入口 `@gchigoo/skeg/provider-api`：`defineProvider` / `SkegProviderV1` / `apiVersion: 1`
- `providers[]` 对象形式：`{ id, spec, required?, priority? }`（字符串仍兼容）
- Provider 输出校验（`src/providervalidate.ts`）与 `source: provider:<id>` provenance
- RecordSelector `{ mode: 'augment'|'replace', records }`；确定性 policy/check 合并
- `npx skeg-provider-test` conformance 工具
- runtime invariants：required fail-closed、malformed hits、dedupe、冲突 diagnostic、augment、session freeze

### Changed
- required PolicyProvider 加载/运行失败 → mutation block（provider-error）
- 普通字符串子串 CheckMatcher 配置加载时弃用 warning；正则限制长度与 flags（`imsu`）
- `/skeg status` 展示 provider 来源
- `extensions/core.ts` LOC 预算 500 → 600（保留“逻辑进 src/”约束，给 Pi 桥接层留接线余量）

## 0.6.1 — 2026-07-22

Trusted Evidence.

### Added
- Provider workspace trust（`src/trust.ts`）：`~/.skeg/trust.json`，绑定内容哈希；`/skeg trust|untrust|providers|providers reload`
- Shell 退出码完整性（`src/exitintegrity.ts`）：掩盖退出状态的命令不记为 check 证据
- SECURITY.md Provider threat model

### Changed
- `providers[]` 仅允许 `.skeg/providers/**` 相对路径或裸包名；未信任不 `import()`
- 裸包名从项目 cwd 解析（`createRequire`）
- session 冻结 Provider 集合；配置变更需显式 reload
- Policy/Check/Record Provider 运行时错误可见，并在本 session 禁用该 Provider
- RecordSelector 返回空数组时不再吞掉 fallback

### Fixed
- runtime invariant：第三方 CheckProvider 使用非内置命令 + 真实动态加载链路

## 0.6.0 — 2026-07-22

Extension Contract.

### Added
- `PolicyProvider` / `CheckProvider` / `RecordSelector`（`src/providers.ts`）；`.skeg/config.json` 的 `providers[]` 动态加载
- 结构化 `CheckMatcher`：`package-script` / `argv` / `regex`；`/init` 探测改为 package-script
- 扁平命令 `/init` `/run` `/status` `/finish` `/record` 每 session 首次使用弃用提示

### Changed
- tool_call 合并 provider RiskHit（仅追加）；tool_result 在内置分类为 null 时询问 CheckProvider
- inject records 可被 RecordSelector 替换（仍受 300-token 预算）
- runtime invariants：settle 幂等、第三方 check 进入 closure

## 0.5.1 — 2026-07-22

Seal the False-Green Gaps.

### Fixed
- 滚动 workspace fingerprint（`WORKSPACE_OBSERVED`）：同路径内容变化会使旧 checks stale
- `/init` 探测改为锚定正则；`targeted-test` 优先于配置 matcher，杜绝 `echo test` 假绿
- `evaluateClosure` 将 `unresolvedSignals` 纳入 `ok`
- Bash mutation 与 write/edit 统一走 `authorizeMutationPaths`；block/deny 时清理 pending
- Git 不可用时 `diff` fail-closed（逃生：`/finish --waive`）
- Signal 扫描按文件切分 diff，排除 pre-existing 片段

### Added
- `dogfood/runtime-invariants.mjs`（真实 Git fixture；已并入 `verify`）
- `engines.node`、`verify:dist`；公开 `NON_GOALS.md` / `CHANGELOG.md`

## 0.5.0 — 2026-07-22

Evidence & Distribution。

### Added
- CheckSpec / `detectCommandsFromScripts`：`/init` 从 package.json scripts 探测 test/typecheck/lint
- Record 相关性加载：`selectRelevantRecords`（intent 关键词 + changedFiles），注入预算收至 300 tokens
- LICENSE / SECURITY.md / CONTRIBUTING.md
- GitHub Actions 多平台矩阵（ubuntu/windows/macos × Node 22/24）
- 包名 `@gchigoo/skeg`；peerDependency 锁定 `>=0.80.0 <0.90.0`

### Migration
- 旧包名 `skeg` → `@gchigoo/skeg`；命令优先 `/skeg …`，扁平 `/run` 仍兼容

## 0.4.1 — 2026-07-22

Pi Composability。

### Changed
- reconcile/prove 从 `agent_end` 迁到 `agent_settled`
- 状态注入改走 `before_agent_start.systemPrompt`，不再每轮累积持久 message
- 注入预算 500→300（随 0.5 record 相关性一并收紧）
- `/skeg` 单一命令命名空间；新增 `/skeg-fix` prompt；`core.ts` LOC 预算 500

## 0.4.0 — 2026-07-22

No False Green — Correctness Spine。

### Added
- RunState schema v2：`revision`、`CheckRun`、`RiskSignal`、`Gate.hits`、`Waiver`、`WorkspaceBaseline`
- `src/migrate.ts` 自动迁移 v1 session state
- `src/reducer.ts` 串行 event reducer
- Closure evaluator：`/finish` 拒绝 missing/failed/stale；`--waive "reason"`
- Bash effect classifier；成功后才 MUTATION_COMMITTED
- 多 hit gate + action fingerprint；`policies` 替换死配置 `riskTriggers`
- Config diagnostics + last-known-good
- `dogfood/adversarial.mjs` 不变量断言（并入 verify）

### Migration
- 旧 session 中的 RunState 自动升到 schemaVersion 2（revision=0）
- `riskTriggers` 仍可读，诊断提示改用 `policies`

## 0.3.4 — 2026-07-22

Hotfix：危险命令 gate acknowledgement key 碰撞。

### Fixed
- `dangerousCommand` gate key 改为 `trigger:commandFingerprint`，放行一条危险命令后不再免检后续不同危险命令
- `RiskHit.fingerprint` + `gateAcknowledgementKey` / `commandFingerprint`（空白归一化后短 hash）

### Evidence
- `npm run verify`；单测覆盖不同危险命令 key 互异、同归一化命令 key 复用

## 0.3.3 — 2026-07-21

稳定性收束：消除 host dogfood 间歇性失败。零新功能包。

### Fixed
- `classifyCheckCommand`：识别 `node --experimental-strip-types --test`（及同类 node flag + `--test`）为 test / targeted-test
- host dogfood：protected/auth/edit 写入内容每轮唯一 `{{marker}}`，避免残留导致跳过 write、gate 漏触发
- host dogfood：check 场景 prompt 强制 bash tool 并等待结果；去掉 auth「已存在则跳过」
- `tool_result`：重新 `loadConfig`，同 turn 写入的 `checks.commands` 立即生效

### Added
- host dogfood：`--dump-events`（`dogfood/events/*.jsonl`）与 `--repeat N`

### Evidence
- `npm run verify` PASS；`npm run smoke` PASS；core LOC 预算内
- skeg profile flash：Round 15–18 连续 4×13/13（含 `--repeat 3`）
- skeg profile pro：Round 19 13/13
- 收束：Round 5/6/12/13 investigate → fixed；strict / mission / review / Cursor / npm = no-go

## 0.3.2 — 2026-07-21

继续打磨：扩大真实使用面。零新功能包；摩擦驱动修复 CLI flag 解析。

### Fixed
- `hasCliFlag`：`/init --force` 与 `/finish --abandon` 的 `\b--flag` 永不匹配（`--` 前无 word boundary）
- pi-smoke：每次重置 fixture 并 commit，避免脏沙箱导致 lean2/heal 串味

### Added
- host profiles：Blog / repo-nav / st-wb-generator / battle-royale
- host dogfood 场景：df-11 abandon、df-12 protected-gate、df-13 auth-guarded
- `dogfood/organic-runs.mjs`：非固定 13 场景的有机 run 记录
- dependency gate 每次跑使用唯一 marker，避免残留导致跳过 edit

### Evidence
- `npm run verify` PASS；`npm run smoke` PASS；core 330 LOC
- host dogfood：skeg / ado-bug-agent / Blog / repo-nav / st-wb-generator / battle-royale 各 13/13
- organic：skeg 6 + ai-novels-factory 6
- 收束：skeg-strict / mission / review check / Cursor 宿主 / npm 发布 = no-go

## 0.3.1 — 2026-07-21

摩擦驱动补丁：phase 记账修复与 host dogfood 泛化。不加新功能。

### Fixed
- bash 写文件命令（重定向 / tee / sed -i / cp / mv 等）记账 `changedFiles` 并推进 orient → change
- write/edit 在 `tool_call` 即记账（补 `tool_result` 偶发漏路径）
- `agent_end` 兜底：phase 卡在 orient 时用 git 工作区变更自愈后再 prove
- 风险路径 bash 记账同步推进 phase（此前只记文件不推进）

### Added
- `dogfood/profiles/`：host dogfood 按 profile 参数化（`skeg` / `ado-bug-agent`）
- FRICTION.md 改为按 Round 追加，保留历史
- dogfood phase 场景 3 个；`healChangedFilesFromGit` 单测

### Evidence
- `npm run verify` PASS（21 scenarios，含 phase 100%）
- host Round 3（skeg）10/10，`phase stayed orient = 0`
- host Round 4（ado-bug-agent）10/10，`phase stayed orient = 0`
- core extension 328 LOC ≤ 800
- `npm run smoke` PASS（含 phase advanced after edit）

## 0.3.0 — 2026-07-21

Record 回读、真实宿主 dogfood，以及摩擦驱动修复。

### Added
- `listRecords`：扫描 `.skeg/records/`，按 createdAt 倒序返回索引
- standard guidance 注入最近 5 条 records（id + 标题）；compact / 无 records 零注入
- dogfood：3 个 record 场景；`dogfood/FRICTION.md`；`npm run dogfood:host -- --cwd <project>`

### Fixed（ado-bug-agent 真实摩擦）
- 绝对路径不触发 risk glob（`pathMatchCandidates` 后缀匹配）
- `node --test` 计入 command check 启发式
- `loadConfig` 容忍顶层误写的 `commands`

### Evidence
- `npm run verify` PASS
- `dogfood/PI_SMOKE.md` PASS（含 records index inject）
- `dogfood/HOST_DOGFOOD.md` PASS（ado-bug-agent 10/10）
- 收束：skeg-strict / mission / review check 均为 no-go（见 FRICTION.md）

## 0.2.0 — 2026-07-21

command check 自动记账与 guidance 密度配置。

### Added
- `src/checks.ts`：从 bash 验证命令自动分类并写入 `RunState.checks`
  - 启发式：test / targeted-test / lint / typecheck / build
  - `checks.commands` 配置优先于启发式
- `config.guidance`：`compact` | `standard`（默认 standard）
  - compact：仅状态行
  - standard：状态行 + Rules + phase Next 提示 + Project 摘要
- dogfood：3 个 check 场景 + 2 个 guidance 场景

### Evidence
- `npm run verify` PASS
- `dogfood/LAST_RUN.md` PASS（command-check 100%，inject ≤ 800）

## 0.1.0 — 2026-07-21

首个可用 Pi-native 版本。

### Added
- 五原语：Run / Context / Check / Gate / Record
- 工作流：Orient → Change → Prove → Close
- 命令：`/init` `/run` `/status` `/finish` `/record`
- Prompt template：`/fix`
- 策略：lean（默认）/ guarded（风险触发）
- 确定性 riskTriggers：migration、dependency、protectedPaths、dangerousCommand
- Prove 自动 checks：diff、sensitive-keywords、public-api-export
- 预算脚本与 dogfood harness；Pi smoke（2 lean + 1 risk）

### Evidence
- `npm run verify` PASS
- `dogfood/LAST_RUN.md` PASS
- `dogfood/PI_SMOKE.md` PASS（gate: databaseMigration）
