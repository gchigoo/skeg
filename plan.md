# Skeg 推进计划

依据：`roadmap.md`（2026-07-22 修订版）。目标：v0.4 主题 No False Green，四条不变量落地。
估算单位为专注工作日；单人开发，串行为主，标注了可并行项。

## 里程碑总览

| 里程碑 | 主题 | 前置 | 预估 |
|---|---|---|---|
| M0 v0.3.4 | Hotfix：gate key 碰撞 | 无 | 0.5 天 |
| M1 v0.4.0 | Correctness Spine | M0 | 8–12 天 |
| M2 v0.4.1 | Pi Composability | M1 | 3–4 天 |
| M3 v0.5.0 | Evidence & Distribution | M2 | 5–7 天 |

已验证的 API 前提（不构成风险）：

- `tool_call` / `tool_result` 事件均带 `toolCallId`（extensions.md:765/824），PendingMutation 关联可行
- `agent_settled` 存在且语义符合预期（extensions.md:553）
- `before_agent_start` 支持 systemPrompt 链式修改（extensions.md:549）

## M0 — v0.3.4 Hotfix（立即执行）

问题：`gateKey = trigger:path`，`dangerousCommand` 的 path 恒为空串，放行一条危险命令后本 session 全部危险命令免检。

任务：

1. `src/risk.ts`：`RiskHit` 增加 `fingerprint` 字段；`detectDangerousCommand` 填充归一化命令 hash（压缩空白、统一 CRLF 后取短 hash）
2. `extensions/core.ts`：`gateKey` 对 `dangerousCommand` 使用 `trigger:fingerprint`
3. `src/risk.test.ts`：两条不同危险命令 → 第二条仍需 gate；同一命令重复 → 第二次跳过
4. 发布：`npm run verify` 通过 → CHANGELOG → bump 0.3.4 → tag → push

验收：不同危险命令的确认互不复用；现有 13 场景 dogfood 不回归。

## M1 — v0.4.0 Correctness Spine

实施顺序 A→B→C→D→E→G→F→H。临界路径 A→B→D→F。
E 可与 B/C 并行；G 的 config validation 部分可独立穿插。
每个 stage 收尾必须：单测过、`npm run verify` 过、FRICTION.md 记录摩擦。

### Stage A — schema v2 + 迁移 + reducer 骨架（2 天）

一切的前提。schema 变更与旧 state 迁移必须同版。

| 文件 | 任务 |
|---|---|
| `src/types.ts` | RunState v2：`schemaVersion: 2`、`revision`、保留 `risk/riskSource`、`checks: CheckRun[]`、`signals: RiskSignal[]`、`gates: Gate[]`、`waivers: Waiver[]`、`baseline: WorkspaceBaseline` |
| `src/migrate.ts`（新） | v1 RunState → v2（revision=0、旧 checks 标记为 revision 0、空 signals/gates/waivers/baseline）；`latestRunFromEntries` 读到 v1 自动迁移 |
| `src/reducer.ts`（新） | `SkegEvent` 联合类型（RUN_STARTED / MUTATION_COMMITTED / CHECK_RECORDED / SIGNAL_RAISED / GATE_OPENED / GATE_RESOLVED / WORKSPACE_RECONCILED / WAIVER_ADDED / RUN_FINISHED）；纯函数 `reduce(run, event)` |
| `src/run.ts` | 现有 helpers 重构为 reducer 内部实现，保持纯函数可测 |
| `extensions/core.ts` | `persist(next)` 替换为 `dispatch(event)`（串行 Promise 队列骨架，本版先保证单线路正确） |

验收：用 `dogfood/events/` 或归档 session 中的 v1 entry 做迁移 fixture，`/status` `/finish` 行为正常；所有状态变更仅经 reduce 产生。

### Stage B — revision 与 stale checks（1 天）

| 文件 | 任务 |
|---|---|
| `src/types.ts` | `CheckRun { id, name, revision, passed, command?, exitCode?, evidence?, observedAt }` |
| `src/reducer.ts` | MUTATION_COMMITTED：revision+1、phase→change（含从 prove 退回）；CHECK_RECORDED 打上当前 revision；旧 check 保留不删除 |
| `src/run.ts` | `formatStatus` 展示 `pass @ revision N` 与 stale 标注 |
| `src/inject.ts` | checks due 只统计 `revision === run.revision` 的通过项 |

语义决策（roadmap 已定）：全量失效，逃生口 `--waive`；细粒度判定留 M3 且以 dogfood 数据为前提。

验收单测：测试通过后再次 mutation → 该 check 变 stale；stale 不计入 checks done。

### Stage C — workspace baseline（1–1.5 天）

| 文件 | 任务 |
|---|---|
| `src/baseline.ts`（新） | RUN_STARTED 时捕获：`head`、`capturedAt`、`dirtyFiles`（git status）、`fileFingerprints`（内容 hash，仅脏文件） |
| `src/prove.ts` | diff 基准固定为 `baseline.head`（不再用当前 HEAD）；reconcile 按指纹区分本 run 变化与既有变化；HEAD 移动视为一次工作区变化（revision+1），基准不变 |
| 输出 | `Run changes` 与 `Pre-existing workspace changes` 分开展示；后者默认不进入证明范围 |

验收单测：run 前已有脏文件不归因；run 中途 `git commit` 后已提交改动不从归因与 diff 证据中丢失。

### Stage D — 成功后记账 + bash effect 分类（2 天）

撤销 v0.3.1「tool_call 即记账」决策，reconcile 兜底必须同版落地。

| 文件 | 任务 |
|---|---|
| `src/effects.ts`（新） | `classifyBashEffect(command)` → read / file-mutation / dependency-mutation / migration-execution / destructive / unknown；覆盖 roadmap 第六节列出的高价值命令集；复合命令（`&&` `;` `\|`）拆段取各段 effect 的并集 |
| `src/paths.ts` | `toWorkspacePath(cwd, path)`：解析 `..`、绝对路径、Windows drive、不存在的新文件、符号链接、工作区外标记；默认策略：工作区外写入 block、`.git/**` 写入 block、工作区外读取 observe |
| `extensions/core.ts` | tool_call 只做风险预检 + 暂存 `PendingMutation`（按 `toolCallId` 关联）；tool_result 成功 → MUTATION_COMMITTED；失败 → 记 attempted，不动 revision/changedFiles；unknown effect 只观察，由 settled reconcile 判定 |
| `src/risk.ts` | read 类 effect 不触发 gate、不记变更（`cat migrations/001.sql` 用例）；`pnpm add zod` 等依赖命令经 effect 分类识别为 dependency-mutation |

验收单测：edit 失败 revision 不增；被 gate 拒绝的 write 不进 changedFiles；读命令不弹 gate 不记变更；`pnpm add zod` 命中 dependencyChange；dogfood 回归 v0.3.1 当初的宿主漏路径场景（reconcile 兜底接住）。

### Stage E — 多 hit gate + action fingerprint（1–1.5 天，可与 B/C 并行）

开始前先花半小时验证 `ctx.ui.confirm` 多行 body 的展示上限（唯一未验证的 UI 前提）。

| 文件 | 任务 |
|---|---|
| `src/types.ts` | `Gate { id, hits: RiskHit[], actionFingerprint, scope: 'call'\|'path'\|'run', status }` |
| `extensions/core.ts` | 一次 tool_call 的全部 hits 合入一个 gate、一次 confirm 展示全部；确认 key 按动作类型生成（文件：trigger+规范化路径；命令：trigger+命令 hash；迁移：trigger+命令+路径）；默认 scope=call |
| `src/run.ts` | gates 作为历史列表保留在 RunState |

验收单测：一个调用命中 protectedPaths+dependencyChange+dangerousCommand 三项 → 全部展示、全部处理；放行 A 命令后 B 命令仍被 gate。

### Stage G — signal/check 分离 + config validation（1.5–2 天）

| 文件 | 任务 |
|---|---|
| `src/types.ts` | `RiskSignal { id, trigger, strength, evidence, revision, requiredChecks?, requiresGate?, acknowledged? }` |
| `src/prove.ts` | sensitive-keywords / public-api-export 改为 SIGNAL_RAISED（不再是 passed:false 的 check）；signal 驱动 risk 升级与 requiredChecks 注入；diff check 保留为 check |
| `src/config.ts` | `ConfigLoadResult { config, source: project/default/last-known-good, diagnostics }`；JSON 错误 → 可见警告 + last-known-good（session 内存中保留上次成功解析结果）；字段类型错误指出 JSON path；`riskTriggers` → `policies`（ignore/observe/confirm/block），旧字段兼容读取并出 deprecation 诊断 |
| `src/risk.ts` | `requiresGate` 改为读 policy action，删除硬编码 |
| `templates/config.json`、`src/init.ts` | 同步 policies 模型 |
| `src/inject.ts`、`src/run.ts` | 状态展示区分 Signal / Check / Gate 三类 |

验收单测：config JSON 损坏 → 显式警告且用 last-known-good；`policies.dependencyChange.action=observe` 时依赖变更不弹 gate 只观察；export 变化产生 signal 而非 failed check。

### Stage F — closure evaluator + /finish + waiver（1.5 天，最后实现）

依赖 B（stale）、E（gates）、G（signals），必须收尾做。

| 文件 | 任务 |
|---|---|
| `src/closure.ts`（新） | `evaluateClosure(run, config)` → `{ ok, missing, failed, stale, openGates, unresolvedSignals }`；required = config.checks ∪ 当前 revision signals 的 requiredChecks；只接受 `check.revision === run.revision`；waiver 只对当前 revision 生效 |
| `extensions/core.ts` | `/finish`：evaluateClosure 不通过 → 按 roadmap 第二节格式输出 Missing/Stale/Open gates 并拒绝；`--waive "reason"` → WAIVER_ADDED 后重评；不提供无理由 force |
| `src/run.ts` | close 报告包含 waivers |

验收单测：缺 check / fail check / stale check / open gate 四种情况 `/finish` 均失败且输出对应清单；waive 后可关闭且 waiver 入状态；revision+1 后旧 waiver 失效。

### Stage H — 对抗测试收口（1.5–2 天）

| 文件 | 任务 |
|---|---|
| `dogfood/adversarial.mjs`（新） | roadmap 第十一节 14 条不变量逐条实现为脚本化场景；断言基于 `--dump-events` 事件流与最终 RunState，不依赖模型输出文本 |
| `dogfood/host-dogfood.mjs` | 接入不变量断言模式；输出 False-done rate / Stale evidence acceptance / Pre-existing attribution / Deterministic gate miss / Duplicate state writes / Active injected tokens 六项指标 |
| `package.json` | `npm run dogfood:adversarial` 并入 `verify` |

不变量与 stage 对应：stale（B）、edit 失败与读命令（D）、dirty file 归因与 git commit（C）、多 trigger 与危险命令（E/M0）、config 错误可见（G）、`/finish` 拒绝（F）、v1 迁移（A）、并行完成与 Pi retry（M2 承接，此处先留桩标注 skip 原因）。

### M1 发布清单

1. `npm run verify` 全绿（含 adversarial）
2. 六项指标达标：前四项 = 0，Duplicate state writes 趋近 0
3. 完成标准复核：任何 fixture 中缺失/失败/过期证据都不能产生 done
4. CHANGELOG + 旧 session 迁移说明（schema v1→v2 自动迁移，无手工步骤）
5. bump 0.4.0 → tag → push → memory-bank 更新

## M2 — v0.4.1 Pi Composability

任务（无强依赖，按此顺序做）：

1. 生命周期迁移：reconcile+prove 从 `agent_end` 移到 `agent_settled`；`agent_end` 只留 telemetry；补 Pi 自动 retry 不过早进 prove 的对抗用例（M1 留桩）
2. reducer 并行事件队列：dispatch 串行化收严 + 两工具交错完成的单测（changedFiles/check 不丢失），补 M1 留桩用例
3. 注入去重：改用 before_agent_start 的 systemPrompt 链提供当前状态，停止每轮返回持久 message；历史 session 中已存在的旧 context message 无需清理（只增不改）
4. 注入预算收紧至 500 tokens（`src/inject.ts` + 预算脚本断言注入构建产物）
5. `/skeg` 单一命令：注册单个 `skeg` 命令 + 子命令解析（init/start/status/finish/record）；同版同步迁移 `prompts/fix.md` → `skeg-fix.md`、`templates/`、README、`dogfood/host-dogfood.mjs` `run.ts` `scenarios.ts` `pi-smoke.mjs` `organic-runs.mjs` `profiles/*`；CHANGELOG 标注 breaking + 旧命令对照表
6. `check-budgets.mjs`：core.ts LOC 预算 800 → 500（当前约 380 行，有余量）

发布清单：verify 全绿 + host dogfood 用新命令全量重跑一轮 + bump 0.4.1 → tag → push。

## M3 — v0.5.0 Evidence & Distribution

功能项：

1. CheckSpec / CheckRun：check 定义配置化（id、命令匹配、适用 risk 级别）；`classifyCheckCommand` 迁移到 spec 驱动
2. 项目命令自动探测：从 package.json scripts 推断 test/typecheck/lint 命令，`/skeg init` 时写入 config
3. record 相关性加载：按当前 intent 关键词 + changedFiles 路径 + record 标题/tags 匹配，替换「最近五条」；同版把注入预算收到 300 tokens
4. 细粒度 stale 判定（可选门槛）：仅当 M1/M2 dogfood 指标显示全量失效导致的重验成本过高时实施，复用 baseline 指纹

分发项：

5. 包名改 scoped `@gchigoo/skeg`；peerDependency 从 `"*"` 锁定为 CI 实测过的 Pi 版本范围
6. 补 LICENSE（MIT 正文）、SECURITY.md、CONTRIBUTING.md；DESIGN/NON_GOALS/CHANGELOG 保持更新
7. GitHub Actions：windows + ubuntu + macos × Node 22/24 矩阵跑 test/typecheck/budgets/smoke；npm pack 安装验证
8. 正式 GitHub Release：v0.3.4 起补发 Release Notes，含迁移说明

发布清单：CI 三平台全绿 → pack 验证 → Release → memory-bank 收口。

## 全程规则

- 每个 stage 一个 commit 系列，结束跑 `npm run verify`；不跨 stage 攒大改动
- schema/状态相关改动必须带 v1 fixture 回归
- FRICTION.md 按 Round 追加，dogfood 发现的新对抗场景随手补进 adversarial 用例
- roadmap「现阶段明确不要做」清单在 M3 完成前持续生效，新想法先记 NON_GOALS.md 或 memory-bank 再说
- 每个里程碑发布后更新 memory-bank（skeg/design-decisions.md 追加版本小节）

## 风险

| 风险 | 应对 |
|---|---|
| `ctx.ui.confirm` 多行 body 展示受限 | Stage E 开工前用小样例实测；不行则 gate 摘要 + `/status` 看详情 |
| host dogfood 受模型波动影响 | 不变量断言只依赖事件流与 RunState，不断言模型文本 |
| Windows 符号链接/大小写路径边界 | `toWorkspacePath` 单测覆盖；开发环境即 Windows，天然先踩 |
| v1 session 样本不足导致迁移盲区 | 用 `dogfood/events/` 存量事件与归档 session 构造 fixture |
| M1 范围膨胀 | 严守 stage 边界；任何新能力想法一律推迟到 M3 之后评估 |
