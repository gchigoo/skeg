# 总体判断

先给结论：**接下来不要继续增加能力，先把 Skeg 做成一个“绝不假绿”的可靠性内核。**

当前版本已经明显超过普通概念原型：`Orient → Change → Prove → Close` 已经落实为真实状态，Pi 适配层与宿主无关逻辑基本分离，也有 token/LOC 预算、单测、smoke 和 host dogfood。README 中记录的当前版本是 **v0.3.3**，并已有多轮 13/13 dogfood 结果。这个方向是对的。

我建议把下一个版本的主题直接定为：

> **Skeg v0.4 — No False Green**

Skeg 的核心价值不应该是“替 Agent 多做一些流程”，而应该是：

> **任何被 Skeg 标记为 done 的任务，都有与最后一次代码修改对应的、足够新鲜的验证证据。**

---

# 一、最高优先级：给验证证据加入“工作区版本”

这是目前最重要的正确性缺口。

当前 `CheckResult` 只有：

```ts
{
  kind,
  name,
  passed,
  evidence
}
```

同名 check 会直接覆盖，而判断“是否还缺 check”时，只看是否存在同名且 `passed: true` 的结果。同时，文件发生变化时只有 `orient → change`，如果已经进入 `prove` 后再次修改代码，阶段不会退回 `change`。

这意味着下面的流程可能被误判为完成：

```text
运行测试，通过
→ 修改代码
→ /finish
→ 之前的测试仍然被视为有效
```

## 建议引入 `revision`

```ts
type RunState = {
  schemaVersion: 2;
  id: string;
  intent: string;

  revision: number;
  phase: Phase;
  status: RunStatus;
  risk: RiskLevel;
  riskSource: RiskSource;

  changedFiles: string[];
  checks: CheckRun[];
  signals: RiskSignal[];
  gates: Gate[];
  waivers: Waiver[];

  baseline: WorkspaceBaseline;
};

type CheckRun = {
  id: string;
  specId: string;
  revision: number;

  passed: boolean;
  command?: string;
  exitCode?: number;
  evidence?: string;
  observedAt: string;
};
```

规则非常简单：

```text
成功修改工作区
→ revision + 1
→ phase = change
→ 旧 checks 保留为历史，但全部视为 stale

执行验证
→ check.revision = 当前 run.revision

判断完成
→ 只接受 check.revision === run.revision 的证据
```

不要真的删除旧 check。保留它们可以用于状态展示和调试：

```text
targeted-test: pass @ revision 3
current workspace: revision 4
状态：stale
```

这样用户能明确知道不是测试失败，而是**测试早于最后一次修改**。

## stale 判定粒度：v0.4.0 有意采用全量失效

全量失效是最严格、最简单的语义，与 No False Green 直接对应。
代价要显式接受：多文件任务收尾时补一行注释，也会强制重跑全部 checks。
v0.4.0 接受这个代价，逃生口是 `--waive`（见第二节）。

按 check 覆盖范围做细粒度 stale 判定（复用第三节的文件指纹）留到 v0.5+，
且只在 dogfood 数据表明重验成本确实过高时才做，避免过早复杂化。

---

# 二、`/finish` 必须是验证器，而不是“强制完成按钮”

当前 `/finish` 的行为是：

```text
检查 pending gate
→ 运行 prove
→ 无条件 closeRun(..., "done")
```

它没有判断配置要求的 checks 是否缺失、失败或过期。换言之，只要没有未解决的 gate，即使 `targeted-test` 没执行或已经失败，仍可能进入 `done`。

建议把关闭逻辑集中为一个纯函数：

```ts
type ClosureEvaluation = {
  ok: boolean;
  missing: string[];
  failed: string[];
  stale: string[];
  openGates: Gate[];
  unresolvedSignals: RiskSignal[];
};

function evaluateClosure(
  run: RunState,
  config: SkegConfig,
): ClosureEvaluation;
```

核心条件：

```ts
const requiredFromConfig =
  run.risk === "guarded"
    ? config.checks.guarded
    : config.checks.default;

// Signal 要求的额外 check（见第八节）必须并入闭环判断
const requiredFromSignals = run.signals
  .filter(signal => signal.revision === run.revision)
  .flatMap(signal => signal.requiredChecks ?? []);

const required = [
  ...new Set([...requiredFromConfig, ...requiredFromSignals]),
];

const currentChecks = run.checks.filter(
  check => check.revision === run.revision
);

const ok =
  missing.length === 0 &&
  failed.length === 0 &&
  stale.length === 0 &&
  openGates.length === 0;
```

`/finish` 的输出应变成：

```text
Cannot finish.

Missing:
- targeted-test
- typecheck

Stale:
- diff-review passed at revision 2; current revision is 3

Open gates:
- databaseMigration: migrations/004_add_index.sql
```

需要允许用户有意识地接受风险时，不要提供无信息的 `--force`，而是要求理由：

```text
/skeg finish --waive "hotfix rollback path verified manually"
```

并将 waiver 存入状态：

```ts
type Waiver = {
  reason: string;
  missingChecks: string[];
  revision: number;
  createdAt: string;
};
```

waiver 只对 `revision === run.revision` 生效；再次修改代码后 revision 递增，
waiver 随之失效，需要重新给出理由。

这样是“用户明确承担风险”，而不是让工作流悄悄假绿。

---

# 三、在 `/run` 时建立 baseline，避免把旧改动算到当前任务

当前 prove 基于：

```text
git diff --name-only HEAD
git status --porcelain
git diff HEAD
```

也就是读取相对于 `HEAD` 的整个工作区。假如启动 Skeg 前仓库已经有未提交改动，这些改动也会进入当前 run 的 `changedFiles`、风险扫描和 diff 证据。

例如：

```text
启动 Skeg 前：
  M src/unrelated.ts

当前任务只修改：
  M src/auth/logout.ts

Skeg 当前看到：
  src/unrelated.ts
  src/auth/logout.ts
```

这会带来两个问题：

1. 当前任务被错误归因；
2. 旧改动可能触发 protected/auth/API 风险，从而制造假 gate。

## 建议在创建 run 时记录工作区快照

```ts
type WorkspaceBaseline = {
  head?: string;
  capturedAt: string;

  dirtyFiles: string[];
  fileFingerprints: Record<string, string>;
};
```

这里不需要保存完整文件，只需给启动前的脏文件保存指纹：

```text
path
当前文件内容 hash
当前 diff hash
文件是否存在
```

后续 reconcile 时：

```text
当前文件指纹 !== baseline 指纹
→ 属于本 run 的变化

当前文件指纹 === baseline 指纹
→ 是 run 启动前已有的变化
```

对于原本干净的文件，进入 dirty 状态就自然属于当前 run。

最终可以区分：

```text
Run changes:
- src/auth/logout.ts

Pre-existing workspace changes:
- src/unrelated.ts
```

后者应展示，但默认不进入当前任务的证明范围。

## diff 基准固定为 baseline.head

run 期间如果发生 `git commit`，`git diff HEAD` 的基准会漂移，
已提交的本 run 改动会从 diff 证据和归因中消失（当前实现同样有此问题）。
prove 与 reconcile 的 diff 基准应固定为 `baseline.head`；
检测到 HEAD 移动时按一次工作区变化处理（revision + 1）。

---

# 四、重做 Gate：一次调用要处理全部风险，而不是只处理第一条

当前一次工具调用只取：

```ts
const hit = hits[0];
```

而 acknowledgement key 是：

```ts
`${trigger}:${path}`
```

危险命令的 `path` 又是空字符串。这会产生两个具体问题：

1. 同一个工具调用同时命中多个风险时，只有第一条被处理；
2. 用户允许过一次危险命令后，因为 key 都可能是 `dangerousCommand:`，后续不同危险命令也可能被当成已确认。

例如一个调用可能同时命中：

```text
protectedPaths
dependencyChange
dangerousCommand
```

不应该只显示第一项。

## 建议让 Gate 包含多个 hit

```ts
type Gate = {
  id: string;
  hits: RiskHit[];
  actionFingerprint: string;
  scope: "call" | "path" | "run";
  status: "pending" | "approved" | "denied";
};
```

确认界面：

```text
Skeg blocked this action.

Detected:
- dependencyChange: package.json
- protectedPaths: package.json
- dangerousCommand: npm install ... && git push --force

Allow this exact action?
```

确认 key 应根据动作类型生成：

```text
文件风险：
trigger + canonical project-relative path

危险命令：
trigger + normalized command hash

迁移执行：
trigger + migration command + affected path
```

默认确认范围应是 `call`。只有明确安全的路径级策略才使用 `path`，不要轻易使用整个 run 级别的 acknowledgement。

---

# 五、写入记账只能发生在工具成功之后

当前 `write` 和 `edit` 在 `tool_call` 阶段就调用了 `noteFileChanges`，之后在 `tool_result` 又记一次。也就是说，即使工具调用被 gate 拒绝、执行失败，run 也可能提前进入 `change`，并把目标路径记为 changed。

注意：tool_call 即记账是 v0.3.1 有意引入的决策（补偿部分宿主 tool_result
偶发缺路径）。本节等于显式撤销该决策，因此 `PendingMutation` 与
`agent_settled` 的 git reconcile 兜底必须同版落地，并在 dogfood 中回归验证
当初的漏路径场景，避免修新问题引回旧问题。

建议明确区分：

```text
tool_call   = 尝试 / 风险预检
tool_result = 已执行事实
```

正确流程：

```text
tool_call
→ 提取预期影响
→ 风险判断
→ gate / allow
→ 不修改 RunState 的 revision 和 changedFiles

tool_result 成功
→ 确认 mutation
→ revision + 1
→ changedFiles 更新
→ phase = change

tool_result 失败
→ 记录 attempted action
→ 不增加 revision
→ 不记 changedFiles
```

可以增加一个短期内存结构：

```ts
type PendingMutation = {
  toolCallId: string;
  expectedPaths: string[];
  effect: BashEffect | "write" | "edit";
};
```

如果某些宿主工具结果确实不带路径，再在 `agent_settled` 使用 Git reconcile 兜底，而不是在调用前假定写入成功。

---

# 六、把 Bash 从“路径猜测”升级为“副作用分类”

现在任意 Bash 调用都会提取路径并进行风险扫描；而在工具成功后，即使命令不是写入，只要路径命中风险规则，也可能被记为文件变更。路径归一化本身也只替换斜杠和移除前导 `./`，没有解析 `..`、工作目录边界或符号链接。

因此这类命令可能出现错误语义：

```bash
cat migrations/001.sql
```

它是读取，却可能被当作 migration 变更。

而这类命令：

```bash
pnpm add zod
```

真实修改了依赖，但命令参数中未必直接出现 `package.json`，仅靠路径提取可能识别不到。

## 增加一个小型 effect classifier

```ts
type BashEffect =
  | { kind: "read" }
  | { kind: "file-mutation"; paths: string[] }
  | { kind: "dependency-mutation"; ecosystem: string }
  | { kind: "migration-execution"; command: string }
  | { kind: "destructive"; fingerprint: string }
  | { kind: "unknown" };
```

首版不需要做完整 Shell parser，只需覆盖高价值类别：

```text
read:
cat, grep, rg, sed without -i, find, ls, git diff

file mutation:
>, >>, tee, touch, mv, cp, rm, sed -i

dependency mutation:
npm/pnpm/yarn/bun add/remove/install
pip/uv/poetry add/remove
cargo add/remove

migration execution:
prisma migrate
alembic upgrade/downgrade
rails db:migrate
django migrate

destructive:
rm -rf
git push --force
DROP TABLE / DATABASE
```

`unknown` 默认只做观察，不要自动记 changedFiles。最终是否发生变化由 git reconcile 判断。

## 路径必须转为 workspace-relative canonical path

```ts
function toWorkspacePath(
  cwd: string,
  inputPath: string,
): {
  relativePath: string;
  outsideWorkspace: boolean;
};
```

至少处理：

```text
绝对路径
相对路径
..
Windows drive
不存在的新文件
符号链接
工作区外路径
```

建议默认：

```text
工作区外写入：block
.git/** 写入：block
工作区外读取：observe
```

---

# 七、`riskTriggers` 要么真正生效，要么删除

当前配置定义了：

```json
{
  "riskTriggers": {
    "dependencyChange": "guarded",
    "publicApiChange": "guarded",
    "databaseMigration": "guarded",
    "authChange": "guarded"
  }
}
```

但从当前调用路径看，`requiresGate()` 对六类 trigger 全部硬编码为需要 gate，并没有读取 `riskTriggers`。另外，配置解析失败时会静默回退到默认配置。这样用户配置的 `authPaths`、`apiPaths` 等保护可能在 JSON 出错时无提示地失效。

我建议直接把配置模型改为“策略动作”，而不是只有风险等级：

```json
{
  "policies": {
    "protectedPaths": {
      "risk": "guarded",
      "action": "confirm"
    },
    "databaseMigration": {
      "risk": "guarded",
      "action": "confirm"
    },
    "dependencyChange": {
      "risk": "guarded",
      "action": "observe"
    },
    "dangerousCommand": {
      "risk": "guarded",
      "action": "block"
    }
  }
}
```

支持四种动作就够了：

```text
ignore
observe
confirm
block
```

配置加载也应返回诊断，而不是只返回配置：

```ts
type ConfigLoadResult = {
  config: SkegConfig;
  source: "project" | "default" | "last-known-good";
  diagnostics: ConfigDiagnostic[];
};
```

处理策略：

```text
配置文件不存在
→ 使用默认配置，正常

配置文件格式错误
→ 显示明确警告
→ 优先使用 last-known-good
→ 没有 last-known-good 时使用保守默认值

字段类型错误
→ 指出具体 JSON path
→ 不静默忽略
```

这会让 `.skeg/config.json` 成为真正可信的工程策略，而不是“看起来可配置”。

---

# 八、把风险 Signal 和验证 Check 分开

当前 diff 分析会把：

```text
sensitive-keywords
public-api-export
```

作为 `passed: false` 的 checks，同时又用它们把 risk 升级为 guarded。

但它们本质上不是“验证失败”，而是：

> 发现了可能需要额外验证的风险信号。

建议改为：

```ts
type RiskSignal = {
  id: string;
  trigger: string;
  strength: "deterministic" | "semi" | "weak";
  evidence: string;
  revision: number;

  requiredChecks?: string[];
  requiresGate?: boolean;
  acknowledged?: boolean;
};
```

例如发现 export 变化：

```text
不是：
public-api-export: fail

而是：
Signal: public API may have changed
Action:
- risk → guarded
- add required check: api-contract-review
```

这样 Closure 语义会清晰很多：

```text
Signal 决定需要什么证据
Check 证明证据是否满足
Gate 决定是否需要人类确认
```

这三个概念不要再混用。

---

# 九、Pi 生命周期还可以更原生

## 从 `agent_end` 移到 `agent_settled`

当前自动 reconcile 和 prove 放在 `agent_end`。但 Pi 官方文档明确说明，`agent_end` 之后仍可能发生自动重试、自动压缩重试或 queued follow-up；需要确认 Pi 不再自动继续时，应使用 `agent_settled`。

建议调整为：

```text
agent_end
→ 最多记录低层 telemetry
→ 不推进 prove

agent_settled
→ reconcile workspace
→ 更新 changedFiles / signals
→ 显示还有哪些 checks due
→ 不自动 close
```

真正的 closure 仍只发生在 `/finish`。

---

## 不要每轮注入新的持久化 context message

当前 `before_agent_start` 返回 `skeg/context` message。Pi 文档说明，这种 message 会被持久化到 session，并发送给 LLM。与此同时，Skeg 自己的运行状态已经通过 `appendEntry` 保存；而 custom entry 本身不会进入 LLM context。

如果每轮都添加一条新的状态 message，会留下多个历史版本：

```text
revision 1 context
revision 2 context
revision 3 context
...
```

即使每条都不长，也会增加上下文噪声，并让模型同时看到过期状态。

建议：

```text
appendEntry
→ 只负责持久化权威状态

before_agent_start.systemPrompt
或 context hook
→ 每轮只提供当前状态
→ 不累积历史状态 message
```

一个适合注入的状态块其实可以控制在 200–300 tokens：

```text
Skeg
Intent: ...
Phase: change
Revision: 4
Risk: guarded
Changed: 3 files
Checks due: targeted-test, typecheck
Gate: none
Rule: evidence must match revision 4
```

你目前把注入硬预算设为 800 tokens。建议分两步收紧：
v0.4.1 去掉累积历史后先收到 **500 tokens**（当前注入含 project summary 与
records 索引，直接砍到 300 会先失去这部分上下文）；
v0.5 record 相关性加载落地后再收到 **300 tokens**。

---

## 对并行工具结果使用串行 reducer

Pi 默认并行工具模式下，工具结果和执行结束事件可能按完成顺序交错。

当前规模下未必已经频繁产生问题，但现在正是固定状态更新模型的最佳时间。

排期注意：下文的 MUTATION_COMMITTED、CHECK_RECORDED 等事件正是 v0.4.0
正确性改造的载体，reducer 骨架应随 v0.4.0 一起落地，否则同一批状态更新代码
要在两个版本里改写两遍；v0.4.1 只补并行事件队列。

一个最小实现：

```ts
let queue = Promise.resolve();

function dispatch(event: SkegEvent): Promise<void> {
  queue = queue.then(() => {
    const next = reduce(run, event);

    if (!sameState(run, next)) {
      run = next;
      pi.appendEntry(RUN_ENTRY_TYPE, next);
    }
  });

  return queue;
}
```

以后所有状态变化都通过 reducer：

```text
RUN_STARTED
GATE_OPENED
GATE_APPROVED
MUTATION_COMMITTED
CHECK_RECORDED
WORKSPACE_RECONCILED
RUN_FINISHED
```

这不会让 Skeg 变重，反而能让 `core.ts` 更薄、更容易测试。

---

# 十、公共命令最好现在就命名空间化

当前公开了：

```text
/init
/run
/status
/finish
/record
```

这些都是高概率与其他 Pi package 冲突的通用名称。Pi 遇到重名命令时会保留多个版本，并追加 `/review:1`、`/review:2` 之类的数字后缀。

对于一个强调组合与扩展的工具，建议公开包默认只注册一个命令：

```text
/skeg init
/skeg start <intent>
/skeg status
/skeg finish
/skeg record ...
```

Prompt Template 也建议默认使用：

```text
/skeg-fix
```

用户自己的 Pi profile 可以添加本地短别名：

```text
/fix → /skeg-fix
```

这样同时获得：

- 公共生态中的可组合性；
- 个人环境中的输入效率；
- 更清晰的品牌识别；
- 将来增加子命令时不污染全局命令空间。

注意：这是 breaking change，且 Pi 的 `registerCommand` 是扁平命令名，
`/skeg init` 实际是注册单个 `skeg` 命令并自行解析子命令。同版必须同步迁移：

```text
skeg 命令的子命令解析
prompts/ 与 templates/ 中的 /run、/finish 引用
README 与安装示例
dogfood harness 的命令调用
```

---

# 十一、重新定义 dogfood：从“13/13 完成”转为“不变量验证”

当前的 host dogfood 和重复运行很有价值，但 `13/13` 更像场景完成率。README 已经展示了同模型与跨模型重复结果，下一步应重点测试系统是否会产生**错误的完成判断**。

建议给 v0.4 增加以下对抗用例：

| 场景 | 必须满足的不变量 |
|---|---|
| 测试通过后再次编辑 | 旧测试必须变 stale |
| `edit` 执行失败 | revision 不增加 |
| run 前已有 dirty file | 不归入当前 run |
| 一个调用命中两个 trigger | 两个都必须被处理 |
| 允许一条危险命令后执行另一条 | 必须再次 gate |
| `.skeg/config.json` JSON 错误 | 必须可见，不得静默 |
| `cat migrations/001.sql` | 不得记为文件变更，也不得触发 gate |
| `pnpm add zod` | 必须识别 dependency mutation |
| 写入 `src/../.env` | 必须规范化并命中保护 |
| 两个工具并行完成 | 不得丢失 changedFiles/check |
| Pi 自动 retry | 不得过早进入 prove |
| check 在 revision 4，当前 revision 5 | `/finish` 必须失败 |
| run 中途 `git commit` | 已提交的本 run 改动不得从归因与 diff 证据中丢失 |
| 加载 v1 旧 session state | 自动迁移到 schema v2，`/status` 与 `/finish` 行为正常 |

比“13/13”更有价值的指标是：

```text
False-done rate                  = 0
Stale evidence acceptance       = 0
Pre-existing change attribution = 0
Deterministic gate miss         = 0
Duplicate state writes          趋近于 0
Active injected state           ≤ 300 tokens
```

---

# 十二、建议的版本路线

## v0.3.4 — Hotfix（不等 v0.4，立即发布）

`dangerousCommand` 的确认 key 恒为 `dangerousCommand:`（path 为空串），
放行一条危险命令后，本 session 所有后续危险命令都会免检。
修复很小：key 改为 trigger + 归一化命令 hash，不依赖 v0.4 的任何重构。

---

## v0.4.0 — Correctness Spine

只做正确性，不增加新入口：

```text
RunState schemaVersion 2 + 旧 session state 迁移（必须与 schema 变更同版）
串行 event reducer 骨架（状态更新全部走 reduce(run, event)）
revision 与 stale checks（全量失效语义）
closure evaluator（并入 signal.requiredChecks）
workspace baseline（diff 基准固定为 baseline.head）
成功后才提交 mutation（PendingMutation + settled reconcile 同版）
多 hit gate
action fingerprint
config validation
signal/check 分离
对抗测试
```

完成标准：

> 在任何 fixture 中，缺失、失败或过期证据都不能产生 `done`。

---

## v0.4.1 — Pi Composability

```text
agent_end → agent_settled
/skeg 单一命令（同步迁移 prompts/templates/README/dogfood）
状态注入去重
500-token 上下文预算（300 留待 v0.5 与 record 相关性加载同版）
reducer 并行事件队列
```

建议顺便把 `core.ts` 的预算从当前 **800 LOC** 收紧到 **450–500 LOC**。800 LOC 对一个“只做 Pi 适配”的入口来说空间太大，容易让策略逻辑重新回流；`core.ts` 当前约 380 行，收紧即刻可行。当前预算脚本确实只为 `extensions/core.ts` 设置了 800 LOC 上限。

---

## v0.5.0 — Evidence & Distribution

这一阶段再改善可扩展性：

```text
CheckSpec / CheckRun
项目命令自动探测
相关 Record 按路径和关键词加载
300-token 注入预算（与 record 相关性加载同版）
细粒度 stale 判定（可选，视 dogfood 重验成本数据决定）
GitHub Actions 多平台测试
npm pack 验证
正式 GitHub Release
发布与迁移说明
```

目前仓库已有 `v0.3.3` 等 tags，但 GitHub Releases 页面仍为空；`package.json` 的 Pi peer dependency 也是 `"*"`。正式公开分发前，建议改成 scoped 包名，例如 `@gchigoo/skeg`，并将 peer dependency 限定为实际 CI 测试过的 Pi 版本范围。

同时补上仍缺失的：

```text
LICENSE（package.json 已声明 MIT，但文件缺失）
SECURITY.md
CONTRIBUTING.md
```

`DESIGN.md`、`NON_GOALS.md`、`CHANGELOG.md` 已存在，保持随版本更新即可。
尤其是 `NON_GOALS.md`，它是抵抗功能膨胀的重要机制。

---

# 现阶段明确不要做的东西

在上述可靠性闭环完成前，建议暂缓：

```text
更多 Prompt Templates
Skills 系统
Mission / Goal / Epic
Subagent 编排
多 Agent 协作
跨宿主适配
Web UI
复杂 Policy DSL
Embedding / 向量检索
自动生成设计文档
```

Record 也暂时不要引入向量数据库。后续只需要用：

```text
当前 intent 关键词
changedFiles 路径
record 标题和 tags
```

做轻量相关性匹配，就已经比“总是注入最近五条记录”更准确；当前 standard context 会列出最近五条 records，因此随着项目增长，按相关性惰性加载会更符合 Skeg 的设计。

---

# 最终建议

你现在已经证明了 Skeg 的产品形态成立：

```text
不是工作流大全
不是 Prompt 套件
不是 Agent 编排器

而是：
一个围绕任务意图、风险边界和验证证据的轻量控制层
```

下一阶段最重要的不是让它“会做更多”，而是建立四条不可破坏的不变量：

```text
每一次成功修改都会让旧证据失效
每一个 done 都经过统一 closure 判断
每一个风险动作都被完整、精确地识别
每一份注入上下文都只有当前状态，没有历史噪声
```

做到这四点后，Skeg 才真正拥有一个很强的核心卖点：

> **Pi 保持自由，Skeg 防止它在没有最新证据的情况下宣告完成。**