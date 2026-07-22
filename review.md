# 结论

**整体符合预期，完成度大约在 80%–85%。**

v0.5 已经不是“概念验证”，而是形成了一个相对完整的 Pi-native 工程控制层：

- 核心仍然是 `Orient → Change → Prove → Close`；
- `revision` 与 stale evidence 已进入正式状态模型；
- `/finish` 通过统一 closure evaluator 判断；
- baseline、Bash effect classifier、多风险 gate、action fingerprint、显式 waiver 都已经落地；
- 状态注入改为 `systemPrompt`，并设了 300-token 硬预算；
- reconcile/prove 已移动到 `agent_settled`；
- 有 scoped 包、Pi 版本范围、多平台 CI 和 `npm pack --dry-run`；
- 当前 GitHub Actions 在 Node 22/24、Ubuntu/Windows/macOS 的 6 个矩阵任务中成功通过。[GitHub](https://github.com/gchigoo/skeg/releases)

因此，**Skeg 的产品方向已经成立**：

> 它没有重新长成一个 Workflow Suite，而是在成为一个围绕意图、工作区变化、风险与验证证据的最小控制层。

不过，当前 README 使用的 **“No False Green” 还不能视为绝对成立**。静态审查中我发现了两条比较实质的假绿路径，以及几项应该在 v0.5.1 修掉的边界问题。

------

# 已达到预期的部分

## 1. 正确性模型已经从文档变成代码

`RunState` 现在有 schemaVersion、revision、checks、signals、gates、waivers 和 baseline；每次明确的成功 mutation 都会递增 revision，而同名 check 只在同一 revision 内覆盖，旧 revision 证据会被保留为历史。这是上次建议中最核心的一步。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/reducer.ts)

Closure evaluator 也确实按当前 revision 区分 fresh、missing、failed 和 stale，并将 waiver 限定在当前 revision。这已经比绝大多数 Agent Workflow 的“执行过测试就算验证”可靠得多。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/closure.ts)

## 2. Pi 集成方式明显更干净

当前状态通过自定义 session entry 持久化，而模型侧只在 `before_agent_start` 收到当前状态的 system prompt，不再不断累积历史 context message。reconcile/prove 也放到了 `agent_settled`，而不是可能仍会自动继续运行的 `agent_end`。[GitHub](https://github.com/gchigoo/skeg/blob/master/extensions/core.ts)

注入层有真实的 300-token 上限，并且测试覆盖了 standard、compact、checks 和 relevant records 等情况。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/inject.ts)

## 3. 风险、Signal 和 Check 已经基本解耦

敏感关键词和 export 变化现在作为 `RiskSignal`，而不是伪装成 failed check；signal 可以增加 required checks 和升级风险等级。这使语义变成：

```
Signal 发现风险
Check 提供证据
Gate 请求确认
Closure 决定能否完成
```

这个方向是正确的。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/prove.ts)

## 4. 轻量化仍然守住了

当前项目仍明确声明“Everything else is an extension”，核心命令优先收敛在 `/skeg` 命名空间，`core.ts` 也设置了 500 LOC 预算；这说明功能增加还没有导致架构重新退回大型 skill router。[GitHub](https://github.com/gchigoo/skeg)

------

# v0.5.1 必须优先修的两个问题

## P0：同一个已知文件被“未知 Bash 命令”再次修改，可能不会让旧证据失效

这是目前最重要的语义缺口。

当前 `MUTATION_COMMITTED` 会无条件递增 revision，这部分正确；但 workspace reconcile 的 revision bump 条件是：

```
const trulyNew = event.changedFiles.filter(
  file => !run.changedFiles.includes(file)
);

const shouldBump =
  trulyNew.length > 0 ||
  event.headMoved;
```

也就是说，reconcile 只在发现**新的路径**或 HEAD 移动时递增 revision。一个已经存在于 `run.changedFiles` 中的文件，即使内容又发生变化，也不会递增。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/reducer.ts)

大多数 `write`、`edit`、重定向、依赖安装等操作会被 effect classifier 捕捉，因此正常会产生 `MUTATION_COMMITTED`。但下面这种命令可能被分类为 `unknown`，且 `expectedPaths` 为空：

```
node -e "require('fs').writeFileSync('src/a.ts', '...')"
```

可能出现：

```
revision 1
→ targeted-test pass
→ diff pass
→ unknown Bash 再次修改 src/a.ts
→ tool_result 没有 MUTATION_COMMITTED
→ agent_settled reconcile 仍发现 src/a.ts
→ 但 src/a.ts 已在 changedFiles
→ revision 不增加
→ 旧 checks 仍被视为 fresh
```

`runProveChecks()` 也有意只对 `trulyNew` 文件发送 `WORKSPACE_RECONCILED`，因此不会补救同路径内容变化。[GitHub](https://github.com/gchigoo/skeg/blob/master/extensions/core.ts)

### 建议：加入滚动工作区指纹

不要用“是否出现新路径”表示“工作区是否变化”，改成比较工作区观察值：

```
type WorkspaceObservation = {
  hash: string;
  head?: string;
  observedRevision: number;
  observedAt: string;
};
```

规则可以是：

```
明确的 mutation tool 成功
→ revision + 1
→ 暂不额外计算 hash

agent_settled
→ 计算当前 run-scoped workspace hash

hash 与上次不同，且 observedRevision === revision
→ 发生了未记账变化
→ revision + 1

hash 与上次不同，但 observedRevision < revision
→ 变化已由 MUTATION_COMMITTED 记账
→ 仅更新 observation，避免双重递增
```

Hash 不必包含完整仓库，可以由以下内容组成：

```
HEAD
run-scoped changed file paths
每个文件的 content/diff fingerprint
```

需要新增一条强制对抗用例：

```
测试通过
→ unknown Bash 修改同一个已知文件
→ agent_settled
→ revision 必须增加
→ 旧测试必须 stale
```

------

## P0：自动探测出的 CheckSpec 匹配过宽，可以制造伪测试证据

`/init` 从 `package.json` 发现 `test`、`typecheck`、`lint`、`build` 后，目前生成的是：

```
{
  test: "test",
  typecheck: "typecheck",
  lint: "lint",
  build: "build"
}
```

而配置命令匹配使用的是：

```
command.includes(pattern)
```

并且配置匹配优先于内置的 targeted-test 识别。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/checks.ts)

这会产生两个问题。

### 假阳性

以下无关命令都可能被记为成功的 `test`：

```
echo test
cat test.log
node scripts/contest.js
```

在 guarded 模式中，只要工具调用没有报错，就有可能满足 required `test`。

### targeted-test 被降级成 test

初始化后的配置中存在 `"test": "test"` 时：

```
pnpm test src/auth/logout.test.ts
```

会先命中配置中的 `"test"`，返回：

```
name: test
```

而不是：

```
name: targeted-test
```

当前单测针对 `DEFAULT_CONFIG` 验证了 targeted-test，但没有覆盖“经过 `/init` 自动探测后”的配置，也没有覆盖 `echo test` 之类的命令。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/checks.test.ts)

### 建议：把 CheckSpec 改成结构化 matcher

```
type CheckMatcher =
  | {
      kind: "package-script";
      manager: "npm" | "pnpm" | "yarn" | "bun";
      script: string;
    }
  | {
      kind: "argv";
      executable: string;
      args: string[];
    }
  | {
      kind: "regex";
      pattern: string;
    };
```

例如：

```
{
  "name": "test",
  "match": {
    "kind": "package-script",
    "script": "test"
  }
}
```

最低成本的补丁方案则是让 `/init` 生成锚定正则：

```
{
  "test": "/^(npm|pnpm|yarn|bun)\\s+(run\\s+)?test(?:\\s|$)/i"
}
```

同时调整优先级：

```
targeted test 语义识别
→ 精确配置 matcher
→ bare test
→ typecheck / lint / build
```

建议马上新增：

```
echo test                         → null
cat test.log                      → null
pnpm test src/a.test.ts           → targeted-test
pnpm test                         → test
pnpm run typecheck                → typecheck
npm run contest                   → null
```

------

# 另外四项应在 v0.5.x 修复

## P1：`unresolvedSignals` 被计算和展示了，但不会阻止 closure

Closure evaluator 会找出：

```
s.requiresGate && !s.acknowledged
```

的 unresolved signals，失败信息也会展示这些 signals；但 `ok` 的计算只包含 missing、failed、stale 和 openGates，没有包含 `unresolvedSignals.length === 0`。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/closure.ts)

当前内置的两个 heuristic signals 没有设置 `requiresGate`，因此暂时不容易触发。但类型和扩展接口既然允许它存在，未来自定义 signal 会出现：

```
结果中显示 unresolved signal
但 evaluateClosure().ok === true
```

直接补一行即可：

```
const ok =
  missingOnly.length === 0 &&
  failed.length === 0 &&
  stale.length === 0 &&
  openGates.length === 0 &&
  unresolvedSignals.length === 0;
```

并增加对应 closure test。

------

## P1：Bash 写出工作区没有使用和 write/edit 相同的边界检查

`write` 和 `edit` 会将路径转成 workspace-relative canonical path，并阻止工作区外以及 `.git/**` 写入。但 Bash effect 的路径只是调用 `toWorkspacePath(...).relativePath`，没有检查 `outsideWorkspace`。[GitHub](https://github.com/gchigoo/skeg/blob/master/extensions/core.ts)

因此类似：

```
echo secret > ../outside.txt
```

即使被识别为 `file-mutation`，也不一定会被通用的 workspace boundary 阻止。风险扫描主要匹配 protectedPaths、migrationPaths、dependency files、API/auth paths，并不存在一个通用的 outside-workspace trigger。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/risk.ts)

建议抽出唯一入口：

```
function authorizeMutationPaths(
  cwd: string,
  paths: string[],
): AuthorizedPaths;
```

所有这些工具都必须使用它：

```
write
edit
bash file-mutation
bash dependency-mutation
未来扩展提供的 mutation tool
```

默认规则：

```
workspace 外写入 → block
.git 或 .git/** → block
workspace 外读取 → observe
```

此外，pending mutation 是在 gate 判定前写入表中的；动作被 block 或用户拒绝时，也应该显式清掉对应 `toolCallId`。

------

## P1：Git 不可用时，`diff` 当前是 fail-open

当 Git diff 获取失败时，当前逻辑是：

```
passed: run.changedFiles.length > 0
```

也就是只要 Skeg 曾经追踪到某个文件，`diff` 就可以通过，evidence 只是“git unavailable; using tracked files”。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/prove.ts)

这与 “No False Green” 的原则不完全一致，因为 tracked path 不能证明：

- 文件目前仍然包含预期修改；
- 没有额外修改；
- diff 与任务意图一致；
- 工作区没有在之后发生未知变化。

建议默认 fail-closed：

```
{
  name: "diff",
  passed: false,
  evidence: "git unavailable"
}
```

然后提供两种明确选择：

```
/skeg finish --waive "non-git workspace; manually inspected files"

或配置：
checks.diffFallback = "workspace-hash"
```

如果需要支持非 Git 项目，可以实现独立的 file snapshot/digest check，而不是把“曾经记录过文件路径”当作 diff 证据。

------

## P2：pre-existing 文件从 tracked files 排除了，但没有从 signal diff 中排除

`tracked` 文件列表会过滤 `run.preExistingFiles`，这部分正确；但敏感关键词和 export signal 扫描的是整个 `snapshot.diff`。而这个 diff 是相对于 baseline HEAD 的完整工作区 diff，因此 run 启动前已经存在的旧改动仍可能触发本次 run 的风险升级。[GitHub](https://github.com/gchigoo/skeg/blob/master/src/prove.ts)

这更可能导致“假警报”而不是假绿，但会让 guarded 模式变得吵闹。

建议将 diff 按文件切分，然后只扫描：

```
runChanges - preExistingFiles
```

或者直接执行：

```
git diff <baseline-head> -- <run-scoped-files...>
```

不过对于启动前已经 dirty、随后又被本 run 修改的文件，还需要减去 baseline patch，而不仅仅是按文件名排除。这正好可以和前述 rolling workspace fingerprint 一起设计。

------

# 对抗测试现在“有了”，但还不够权威

这是 v0.5 最值得继续加强的部分。

当前 adversarial dogfood 的 stale 测试是直接派发 `MUTATION_COMMITTED`，所以它证明的是 reducer 在收到正确事件后工作正常，并没有证明宿主事件、Bash 分类和 workspace reconcile 一定会产生正确事件。[GitHub](https://github.com/gchigoo/skeg/blob/master/dogfood/adversarial.mjs)

pre-existing attribution 用例甚至接受两种结果：

```
preExisting.includes(file) ||
runChanges.includes(file)
```

因此即使归因错误，测试也会通过；对应指标则被直接写成固定的 `0`。中途 Git commit 的测试也只是检查 `baseline.head === "oldhead"`，没有建立真实 Git fixture 验证 diff 不会丢失。Pi 自动 retry 场景仍然是 skip。[GitHub](https://github.com/gchigoo/skeg/blob/master/dogfood/adversarial.mjs)

建议把 dogfood 分成两层。

## Reducer invariants

纯函数测试：

```
事件输入正确时
状态转换是否正确
```

## Runtime invariants

在临时 Git 仓库和模拟 Pi event 中执行真实流程：

```
真实写文件
真实运行 Bash
真实 git diff/status
真实 tool_call/tool_result
真实 agent_settled
真实 /finish
```

v0.5.1 至少补以下场景：

| 场景                            | 期望                           |
| ------------------------------- | ------------------------------ |
| unknown Bash 再改已知文件       | revision 增加，旧 checks stale |
| `echo test`                     | 不生成 test check              |
| 自动探测后执行 targeted test    | 生成 targeted-test             |
| Bash 写 `../outside.txt`        | block                          |
| requiresGate signal 未确认      | closure false                  |
| Git 不可用                      | diff false 或显式 waiver       |
| pre-existing diff 含 `password` | 不升级当前 run                 |
| run 中途真实 commit             | diff 仍覆盖本 run 修改         |

同时不要再根据测试名称推导 metric。让每个 invariant 返回结构化结果：

```
{
  falseDone: false,
  staleAccepted: false,
  attributionError: false,
  gateMiss: false
}
```

------

# 分发与仓库治理还有几个小问题

## 1. 设计文档被 .gitignore 刻意排除，与 README 发布配置矛盾

本地实际存在：

```
DESIGN.md
NON_GOALS.md
CHANGELOG.md
```

但 `.gitignore` 将它们标为 "design docs — local only, not published / not tracked"。因此 GitHub 上对应链接 404，而 `package.json` 的 `files` 又包含了 fresh clone 里不存在的 `CHANGELOG.md`。[GitHub](https://github.com/gchigoo/skeg)

根因不是文件缺失，而是本地化策略与对外引用不一致。建议按部分公开策略处理：

```
公开：NON_GOALS.md、CHANGELOG.md（从 .gitignore 移除并提交）
保持本地：DESIGN.md（README 移除其引用）
```

其中 `NON_GOALS.md` 继续明确：

```
不内置 subagent 编排
不引入多 workflow 状态机
不默认生成任务 artifact
不实现大型 policy DSL
不将 Agent 思考步骤编码进 core
```

## 2. 扁平命令仍在污染公共命令空间

虽然 README 推荐 `/skeg …`，但 extension 仍默认注册：

```
/init
/run
/status
/finish
/record
```

以及 `/skeg`。[GitHub](https://github.com/gchigoo/skeg/blob/master/extensions/core.ts)

v0.5 为兼容保留可以理解，但建议定下弃用周期：

```
v0.6：启动时提示 deprecated
v0.8：移动到 skeg-compat
v1.0：主包只注册 /skeg
```

用户自己的 Pi profile 再配置短别名，公共 package 不占用通用名字。

## 3. Release tags 全部指向同一 commit

`v0.3.4`、`v0.4.0`、`v0.4.1`、`v0.5.0` 当前都指向 `b127cf3`，并在同一时间发布。Release note 已说明它们属于同一 release train，因此不算错误，但会降低版本 diff、bisect 和迁移验证的价值。[GitHub](https://github.com/gchigoo/skeg/releases)

不建议重写已发布标签；从下一个版本开始保持：

```
一个版本
→ 一个不可变 commit
→ 一次 CI
→ 一个 tag
→ 一份 release note
```

## 4. 增加 Node engines 和本地分发验证

CI 已经明确只测试 Node 22 和 24，而 `package.json` 没有 `engines`。建议加入：

```
{
  "engines": {
    "node": ">=22 <25"
  }
}
```

或者放宽到实际确认支持的范围。CI 中已有 `npm pack --dry-run`，但本地 `npm run verify` 没有包含它，可以增加：

```
{
  "verify:dist": "npm run verify && npm pack --dry-run"
}
```

相关 CI 当前已经在 6 个矩阵任务中成功通过，只出现了 GitHub Action 自身 Node 20 runtime 的弃用警告，不是 Skeg 测试失败。[GitHub](https://github.com/gchigoo/skeg/blob/master/.github/workflows/ci.yml)

------

# 我建议的后续版本规划

## v0.5.1 — Seal the False-Green Gaps

只修正确性：

```
滚动 workspace fingerprint
同路径内容变化触发 revision
结构化 CheckSpec matcher
unresolvedSignals 阻止 closure
Bash workspace boundary
Git unavailable fail-closed
run-scoped signal diff
真实 Git adversarial fixtures
```

完成标准：

> 无论修改通过 write、edit、已识别 Bash，还是未知 Bash 发生，只要工作区状态在验证后改变，旧证据都必须失效。

## v0.5.2 — Distribution Hygiene

```
补 DESIGN / NON_GOALS / CHANGELOG
增加 Node engines
增加 verify:dist
发布真实 npm package
扁平命令 deprecation warning
每个 release 对应独立 commit
```

## v0.6 — Extension Contract

这一版不要增加 Goal、Epic、Mission 或更多 workflow，而是稳定三个很小的扩展接口：

```
interface PolicyProvider {
  inspect(action: Action): RiskHit[];
}

interface CheckProvider {
  classify(command: Command): CheckSpec[];
}

interface RecordSelector {
  select(context: RunContext): RecordRef[];
}
```

保持两个原则：

```
扩展可以增加 Policy / Check / Record
扩展不能增加新的核心阶段状态机
```

这样第三方可以增加：

```
PostgreSQL migration policy
Terraform protected-path policy
Rust/Cargo check provider
Monorepo workspace check provider
```

但不能让 Skeg 再次变成一个工作流大全。

------

# 最终评价

我会给当前 v0.5 这样的评分：

| 维度             | 评价   |
| ---------------- | ------ |
| 产品方向         | 9/10   |
| Pi-native 组合性 | 9/10   |
| 默认轻量程度     | 8.5/10 |
| 状态模型         | 8/10   |
| 假绿防护         | 7/10   |
| 对抗测试可信度   | 6.5/10 |
| 分发准备度       | 8/10   |

**它已经符合我们最初对 Skeg 的架构预期，但还没有完全满足自己提出的“No False Green”承诺。**

下一步最有价值的不是增加更多功能，而是封死这三条路径：

```
未知 Bash 修改同一文件
过宽的 check 命令匹配
Git 不可用时 diff fail-open
```

完成后，Skeg 就会拥有一个非常清晰且可信的核心卖点：

> **Agent 可以保持自由，但任何 done 都必须对应最后一次真实工作区状态的有效证据。**