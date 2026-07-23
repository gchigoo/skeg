/**
 * Veritack dogfood harness：用宿主无关内核模拟场景并验收硬指标。
 *
 * 用法：node --experimental-strip-types dogfood/run.ts
 *
 * 自动验收：
 * - 注入上下文 ≤ 800 tokens（compact / standard）
 * - lean：0 artifact、0 未解决 gate
 * - 确定性 trigger gate 触发率 100%
 * - /run → 首次编辑工具调用次数中位数 ≤ 4
 * - RunState 可经 entries 恢复且 /status 可读
 * - command check 自动记账正确；非验证命令误记账 = 0
 * - records 索引注入正确（有则注入、无则零注入、compact 不注入）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommandCheck, classifyCheckCommand } from '../src/checks.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { buildInjectContext, estimateTokens } from '../src/inject.ts';
import {
  extractBashWritePaths,
  isBashFileWrite,
} from '../src/paths.ts';
import {
  healChangedFilesFromGit,
  runProveChecks,
} from '../src/prove.ts';
import { createRecord } from '../src/record.ts';
import { requiresGate, scanToolCall } from '../src/risk.ts';
import {
  addChangedFiles,
  applyRiskHit,
  closeRun,
  createRun,
  formatStatus,
  latestRunFromEntries,
  setPhase,
  upsertCheck,
} from '../src/run.ts';
import type { RunState, VeritackConfig } from '../src/types.ts';
import { SCENARIOS, type Scenario, type SimulatedTool } from './scenarios.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_INJECT = 800;
const MAX_MEDIAN_TOOLS = 4;

type ScenarioResult = {
  id: string;
  kind: Scenario['kind'];
  pass: boolean;
  toolsBeforeFirstEdit: number;
  injectTokens: number;
  risk: string;
  gateTrigger?: string;
  failures: string[];
};

/**
 * 将 SimulatedTool 转为 scanToolCall 输入。
 * @param tool 模拟工具调用
 * @returns [toolName, input]
 */
function toToolCall(tool: SimulatedTool): [string, Record<string, unknown>] {
  if (tool.tool === 'bash') {
    return ['bash', { command: tool.command ?? '' }];
  }
  return [tool.tool, { path: tool.path ?? '', content: tool.content ?? '' }];
}

/**
 * 模拟 bash tool_result 的 command check 记账。
 * @param run 当前 run
 * @param tool 模拟 bash
 * @param config 配置
 * @returns 更新后的 run
 */
function applyBashCheck(
  run: RunState,
  tool: SimulatedTool,
  config: VeritackConfig,
): RunState {
  if (tool.tool !== 'bash' || !tool.command) return run;
  const classified = classifyCheckCommand(tool.command, config);
  if (!classified) return run;
  return upsertCheck(
    run,
    buildCommandCheck(
      classified.name,
      tool.command,
      !tool.isError,
      tool.output,
    ),
  );
}

/**
 * 跑单个场景。
 * @param scenario 场景
 * @returns 结果
 */
function runScenario(scenario: Scenario): ScenarioResult {
  const failures: string[] = [];
  const config: VeritackConfig = {
    ...DEFAULT_CONFIG,
    guidance: scenario.guidance ?? DEFAULT_CONFIG.guidance,
  };
  let run = createRun(scenario.intent, config.defaultPolicy);
  const entries: Array<{ type: string; customType: string; data: RunState }> = [];

  // record 场景用临时 cwd 预置 records；其余场景用 process.cwd()
  let injectCwd = process.cwd();
  let tempCwd: string | undefined;
  if (
    scenario.preexistingRecords !== undefined ||
    scenario.kind === 'record'
  ) {
    tempCwd = mkdtempSync(join(tmpdir(), 'veritack-dogfood-'));
    injectCwd = tempCwd;
    for (const rec of scenario.preexistingRecords ?? []) {
      createRecord(tempCwd, {
        type: rec.type,
        title: rec.title,
        body: rec.body,
      });
    }
  }

  try {
    const persist = (next: RunState) => {
      run = next;
      entries.push({ type: 'custom', customType: 'veritack/run', data: next });
    };

    const toolsBefore = scenario.toolsBeforeFirstEdit.length;
    // 仅对 v0.1 基线场景（fix/feature/risk）施加中位数预算
    if (
      (scenario.kind === 'fix' ||
        scenario.kind === 'feature' ||
        scenario.kind === 'risk') &&
      toolsBefore > MAX_MEDIAN_TOOLS
    ) {
      failures.push(
        `tools before first edit = ${toolsBefore} > ${MAX_MEDIAN_TOOLS}`,
      );
    }

    // 模拟 orient 读取；bash 也可能触发 check 记账（如误记检测）
    for (const tool of scenario.toolsBeforeFirstEdit) {
      const [name, input] = toToolCall(tool);
      scanToolCall(name, input, config);
      if (tool.tool === 'bash') {
        persist(applyBashCheck(run, tool, config));
      }
    }

    let gateHit: string | undefined;

    for (const edit of scenario.edits) {
      const [name, input] = toToolCall(edit);
      const hits = scanToolCall(name, input, config);
      const gate = hits.find((h) => requiresGate(h.trigger));
      if (gate) {
        gateHit = gate.trigger;
        persist(applyRiskHit(run, gate));
      }
      if (edit.tool === 'bash' && edit.command) {
        persist(applyBashCheck(run, edit, config));
        if (!edit.isError && isBashFileWrite(edit.command)) {
          const paths = extractBashWritePaths(edit.command);
          if (paths.length > 0) {
            let next = addChangedFiles(run, paths);
            if (next.phase === 'orient') next = setPhase(next, 'change');
            persist(next);
          }
        }
      } else if (edit.path) {
        let next = addChangedFiles(run, [edit.path]);
        if (next.phase === 'orient') next = setPhase(next, 'change');
        persist(next);
      }
    }

    // agent_end 兜底：phase 仍 orient 时用假 git 自愈
    if (run.phase === 'orient') {
      const healed = healChangedFilesFromGit(
        process.cwd(),
        run,
        (_cwd, args) => {
          const files = run.changedFiles;
          if (args[0] === 'status') {
            return `${files.map((f) => ` M ${f}`).join('\n')}\n`;
          }
          if (args.includes('--name-only')) return `${files.join('\n')}\n`;
          return '';
        },
      );
      if (healed !== run) persist(healed);
    }

    if (scenario.expect.phaseAfterEdits) {
      if (run.phase !== scenario.expect.phaseAfterEdits) {
        failures.push(
          `phaseAfterEdits=${run.phase}, want ${scenario.expect.phaseAfterEdits}`,
        );
      }
    }

    for (const tool of scenario.proveCommands ?? []) {
      persist(applyBashCheck(run, tool, config));
    }

    // Prove（注入假 git）
    const proved = runProveChecks(process.cwd(), run, config, (_cwd, args) => {
      if (args[0] === 'status') {
        return `${run.changedFiles.map((f) => ` M ${f}`).join('\n')}\n`;
      }
      if (args.includes('--name-only')) {
        return `${run.changedFiles.join('\n')}\n`;
      }
      if (scenario.kind === 'risk') {
        return run.changedFiles
          .map(
            (f) =>
              `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n+change\n`,
          )
          .join('');
      }
      return run.changedFiles
        .map(
          (f) =>
            `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n+const ok = true;\n`,
        )
        .join('');
    });
    persist(proved.run);

    const inject = buildInjectContext(run, config, injectCwd);
    const injectTokens = estimateTokens(inject);
    if (injectTokens > MAX_INJECT) {
      failures.push(`inject tokens ${injectTokens} > ${MAX_INJECT}`);
    }

    for (const needle of scenario.expect.injectIncludes ?? []) {
      if (!inject.includes(needle)) {
        failures.push(`inject missing "${needle}"`);
      }
    }
    for (const needle of scenario.expect.injectExcludes ?? []) {
      if (inject.includes(needle)) {
        failures.push(`inject unexpectedly contains "${needle}"`);
      }
    }

    // command check 记账断言
    if (scenario.expect.commandChecks) {
      for (const want of scenario.expect.commandChecks) {
        const got = run.checks.find(
          (c) => c.kind === 'command' && c.name === want.name,
        );
        if (!got) {
          failures.push(`missing command check: ${want.name}`);
        } else if (got.passed !== want.passed) {
          failures.push(
            `check ${want.name} passed=${got.passed}, want ${want.passed}`,
          );
        }
      }
    }
    if (scenario.expect.noCommandChecks) {
      const cmds = run.checks.filter((c) => c.kind === 'command');
      if (cmds.length > 0) {
        failures.push(
          `unexpected command checks: ${cmds.map((c) => c.name).join(', ')}`,
        );
      }
    }

    // RunState 恢复
    const restored = latestRunFromEntries(entries);
    if (
      !restored ||
      restored.id !== run.id ||
      restored.intent !== scenario.intent
    ) {
      failures.push('RunState restore via entries failed');
    }
    const status = formatStatus(restored);
    if (!status.includes(scenario.intent)) {
      failures.push('/status text missing intent');
    }

    // lean 约束（risk 除外）
    if (scenario.kind !== 'risk') {
      if ((run.recordIds?.length ?? 0) !== scenario.expect.artifactCount) {
        failures.push(
          `artifactCount=${run.recordIds?.length ?? 0}, want ${scenario.expect.artifactCount}`,
        );
      }
      if (run.pendingGate && !run.pendingGate.resolved) {
        failures.push('lean/feature unexpectedly has open gate');
      }
      if (
        scenario.expect.riskAfterEdits === 'lean' &&
        run.riskSource === 'deterministic'
      ) {
        failures.push('lean task escalated by deterministic risk unexpectedly');
      }
    }

    // 确定性 trigger
    if (scenario.expect.gateTrigger) {
      if (gateHit !== scenario.expect.gateTrigger) {
        failures.push(
          `gate trigger=${gateHit ?? 'none'}, want ${scenario.expect.gateTrigger}`,
        );
      }
      if (run.risk !== 'guarded' || run.riskSource !== 'deterministic') {
        failures.push(
          `risk=${run.risk}/${run.riskSource}, want guarded/deterministic`,
        );
      }
      if (!run.pendingGate || run.pendingGate.resolved) {
        failures.push('expected open pending gate after risk edit');
      }
    } else if (gateHit) {
      failures.push(`unexpected gate trigger: ${gateHit}`);
    }

    if (scenario.kind !== 'risk') {
      persist(closeRun(run, 'done'));
    }

    return {
      id: scenario.id,
      kind: scenario.kind,
      pass: failures.length === 0,
      toolsBeforeFirstEdit: toolsBefore,
      injectTokens,
      risk: `${run.risk}/${run.riskSource}`,
      gateTrigger: gateHit,
      failures,
    };
  } finally {
    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
    }
  }
}

/**
 * 计算中位数。
 * @param values 数值
 * @returns 中位数
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function main() {
  const fixes = SCENARIOS.filter((s) => s.kind === 'fix');
  const features = SCENARIOS.filter((s) => s.kind === 'feature');
  const risks = SCENARIOS.filter((s) => s.kind === 'risk');
  const checks = SCENARIOS.filter((s) => s.kind === 'check');
  const guidance = SCENARIOS.filter((s) => s.kind === 'guidance');
  const records = SCENARIOS.filter((s) => s.kind === 'record');

  if (fixes.length < 5 || features.length < 3 || risks.length < 2) {
    console.error('Scenario mix invalid: need ≥5 fix, ≥3 feature, ≥2 risk');
    process.exit(2);
  }
  if (checks.length < 3 || guidance.length < 2) {
    console.error('v0.2 mix invalid: need ≥3 check, ≥2 guidance');
    process.exit(2);
  }
  if (records.length < 3) {
    console.error('v0.3 mix invalid: need ≥3 record');
    process.exit(2);
  }

  const results = SCENARIOS.map(runScenario);
  const baseline = results.filter(
    (r) => r.kind === 'fix' || r.kind === 'feature' || r.kind === 'risk',
  );
  const toolsMedian = median(baseline.map((r) => r.toolsBeforeFirstEdit));
  const riskResults = results.filter((r) => r.kind === 'risk');
  const riskHitRate =
    riskResults.length === 0
      ? 0
      : riskResults.filter((r) => r.pass).length / riskResults.length;

  const checkResults = results.filter((r) => r.kind === 'check');
  const checkPassRate =
    checkResults.length === 0
      ? 0
      : checkResults.filter((r) => r.pass).length / checkResults.length;

  const recordResults = results.filter((r) => r.kind === 'record');
  const recordPassRate =
    recordResults.length === 0
      ? 0
      : recordResults.filter((r) => r.pass).length / recordResults.length;

  const aggregateFailures: string[] = [];
  if (toolsMedian > MAX_MEDIAN_TOOLS) {
    aggregateFailures.push(
      `median tools before first edit ${toolsMedian} > ${MAX_MEDIAN_TOOLS}`,
    );
  }
  if (riskHitRate < 1) {
    aggregateFailures.push(
      `deterministic trigger pass rate ${riskHitRate * 100}% < 100%`,
    );
  }
  if (checkPassRate < 1) {
    aggregateFailures.push(
      `command-check scenario pass rate ${checkPassRate * 100}% < 100%`,
    );
  }
  if (recordPassRate < 1) {
    aggregateFailures.push(
      `record scenario pass rate ${recordPassRate * 100}% < 100%`,
    );
  }

  const failed = results.filter((r) => !r.pass);
  const pass = failed.length === 0 && aggregateFailures.length === 0;

  const lines = [
    '# Veritack dogfood report',
    '',
    `Date: ${new Date().toISOString()}`,
    `Result: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    '## Aggregate',
    '',
    `- scenarios: ${results.length} (fix=${fixes.length}, feature=${features.length}, risk=${risks.length}, check=${checks.length}, guidance=${guidance.length}, record=${records.length}, phase=${results.filter((r) => r.kind === 'phase').length})`,
    `- median tools before first edit (baseline): ${toolsMedian} (budget ≤ ${MAX_MEDIAN_TOOLS})`,
    `- deterministic risk pass rate: ${Math.round(riskHitRate * 100)}% (budget 100%)`,
    `- command-check pass rate: ${Math.round(checkPassRate * 100)}% (budget 100%)`,
    `- record pass rate: ${Math.round(recordPassRate * 100)}% (budget 100%)`,
    `- max inject tokens: ${Math.max(...results.map((r) => r.injectTokens))} (budget ≤ ${MAX_INJECT})`,
    '',
    '## Scenarios',
    '',
    '| id | kind | pass | tools→edit | inject | risk | gate |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.pass ? 'yes' : 'NO'} | ${r.toolsBeforeFirstEdit} | ${r.injectTokens} | ${r.risk} | ${r.gateTrigger ?? '-'} |`,
    ),
    '',
  ];

  if (failed.length > 0 || aggregateFailures.length > 0) {
    lines.push('## Failures', '');
    for (const f of aggregateFailures) lines.push(`- ${f}`);
    for (const r of failed) {
      lines.push(`- ${r.id}:`);
      for (const msg of r.failures) lines.push(`  - ${msg}`);
    }
    lines.push('');
  }

  lines.push(
    '## Manual follow-up (Pi)',
    '',
    'Re-run 2 lean + 1 risk scenario inside a real Pi session to confirm UX:',
    '- `/veritack init` → `/veritack start` → edit → `/veritack status` → `/veritack finish`',
    '- risk edit must show gate confirm UI',
    '- bash `pnpm test <file>` should appear in `/veritack status` Checks',
    '- `/veritack record decision ...` then next agent turn should inject Records index',
    '',
  );

  const report = lines.join('\n');
  const outPath = join(HERE, 'LAST_RUN.md');
  writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log(`Wrote ${outPath}`);

  if (!pass) process.exit(1);
}

main();
