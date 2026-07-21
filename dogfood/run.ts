/**
 * Skeg v0.1 dogfood harness：用宿主无关内核模拟 10 个任务并验收硬指标。
 *
 * 用法：node --experimental-strip-types dogfood/run.ts
 *
 * 自动验收：
 * - 注入上下文 ≤ 800 tokens
 * - lean：0 artifact、0 未解决 gate
 * - 确定性 trigger gate 触发率 100%
 * - /run → 首次编辑工具调用次数中位数 ≤ 4
 * - RunState 可经 entries 恢复且 /status 可读
 *
 * 人工补测（Pi 实机）：在真实 Pi session 复跑同类任务，确认 UX 与自动结果一致。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { buildInjectContext, estimateTokens } from '../src/inject.ts';
import { runProveChecks } from '../src/prove.ts';
import { requiresGate, scanToolCall } from '../src/risk.ts';
import {
  addChangedFiles,
  applyRiskHit,
  closeRun,
  createRun,
  formatStatus,
  latestRunFromEntries,
  setPhase,
} from '../src/run.ts';
import type { RunState } from '../src/types.ts';
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
 * 跑单个场景。
 * @param scenario 场景
 * @returns 结果
 */
function runScenario(scenario: Scenario): ScenarioResult {
  const failures: string[] = [];
  const config = { ...DEFAULT_CONFIG };
  let run = createRun(scenario.intent, config.defaultPolicy);
  const entries: Array<{ type: string; customType: string; data: RunState }> = [];

  const persist = (next: RunState) => {
    run = next;
    entries.push({ type: 'custom', customType: 'skeg/run', data: next });
  };

  const toolsBefore = scenario.toolsBeforeFirstEdit.length;
  if (toolsBefore > MAX_MEDIAN_TOOLS) {
    failures.push(
      `tools before first edit = ${toolsBefore} > ${MAX_MEDIAN_TOOLS}`,
    );
  }

  // 模拟 orient 读取（不触发写风险）
  for (const tool of scenario.toolsBeforeFirstEdit) {
    const [name, input] = toToolCall(tool);
    scanToolCall(name, input, config); // 只读路径不应升级
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
    if (edit.path) {
      let next = addChangedFiles(run, [edit.path]);
      if (next.phase === 'orient') next = setPhase(next, 'change');
      persist(next);
    }
  }

  // Prove（注入假 git）
  const proved = runProveChecks(process.cwd(), run, config, (_cwd, args) => {
    if (args[0] === 'status') {
      return run.changedFiles.map((f) => ` M ${f}`).join('\n') + '\n';
    }
    if (args.includes('--name-only')) {
      return `${run.changedFiles.join('\n')}\n`;
    }
    // 非 risk 场景给干净 diff；risk 场景给路径相关内容
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

  const inject = buildInjectContext(run, config, process.cwd());
  const injectTokens = estimateTokens(inject);
  if (injectTokens > MAX_INJECT) {
    failures.push(`inject tokens ${injectTokens} > ${MAX_INJECT}`);
  }

  // RunState 恢复
  const restored = latestRunFromEntries(entries);
  if (!restored || restored.id !== run.id || restored.intent !== scenario.intent) {
    failures.push('RunState restore via entries failed');
  }
  const status = formatStatus(restored);
  if (!status.includes(scenario.intent)) {
    failures.push('/status text missing intent');
  }

  // lean 约束
  if (scenario.kind !== 'risk') {
    if ((run.recordIds?.length ?? 0) !== scenario.expect.artifactCount) {
      failures.push(
        `artifactCount=${run.recordIds?.length ?? 0}, want ${scenario.expect.artifactCount}`,
      );
    }
    if (run.pendingGate && !run.pendingGate.resolved) {
      failures.push('lean/feature unexpectedly has open gate');
    }
    // lean 任务不应被 prove heuristic 误伤到仍算失败——允许 advisory guarded，
    // 但 DESIGN 要求 lean：0 人工 gate。advisory 升级不算人工 gate。
    if (scenario.expect.riskAfterEdits === 'lean' && run.riskSource === 'deterministic') {
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

  // close（risk 场景先视为仍 blocked，不强制 close 成功）
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

  if (fixes.length < 5 || features.length < 3 || risks.length < 2) {
    console.error('Scenario mix invalid: need ≥5 fix, ≥3 feature, ≥2 risk');
    process.exit(2);
  }

  const results = SCENARIOS.map(runScenario);
  const toolsMedian = median(results.map((r) => r.toolsBeforeFirstEdit));
  const riskResults = results.filter((r) => r.kind === 'risk');
  const riskHitRate =
    riskResults.length === 0
      ? 0
      : riskResults.filter((r) => r.pass).length / riskResults.length;

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

  const failed = results.filter((r) => !r.pass);
  const pass = failed.length === 0 && aggregateFailures.length === 0;

  const lines = [
    '# Skeg dogfood report',
    '',
    `Date: ${new Date().toISOString()}`,
    `Result: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    '## Aggregate',
    '',
    `- scenarios: ${results.length} (fix=${fixes.length}, feature=${features.length}, risk=${risks.length})`,
    `- median tools before first edit: ${toolsMedian} (budget ≤ ${MAX_MEDIAN_TOOLS})`,
    `- deterministic risk pass rate: ${Math.round(riskHitRate * 100)}% (budget 100%)`,
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
    '- `/init` → `/run` → edit → `/status` → `/finish`',
    '- risk edit must show gate confirm UI',
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
