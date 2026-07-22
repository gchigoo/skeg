/**
 * 构建 before_agent_start 注入文本，目标 ≤ 500 tokens（M3 随 record 相关性收至 300）。
 */

/** 注入硬预算（tokens）；v0.5 与 record 相关性加载同版收至 300 */
export const INJECT_TOKEN_BUDGET = 300;
import { loadProjectSummary } from './config.ts';
import { selectRelevantRecords } from './record.ts';
import { currentChecks, hasFreshPass } from './run.ts';
import type { Phase, RunState, SkegConfig } from './types.ts';

/** standard guidance 注入的 records 索引条数上限。 */
const RECORDS_INDEX_LIMIT = 5;

/**
 * 估算文本 token 数（与 scripts/check-budgets.mjs 同启发式）。
 * @param text 文本
 * @returns 估算 token
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/gu) ?? [];
  const rest = text.length - cjk.length;
  return cjk.length + Math.ceil(rest / 4);
}

/**
 * 按阶段给出一行下一步提示（standard guidance）。
 * @param phase 当前阶段
 * @param missing 尚未通过的期望 checks
 * @returns 提示文本
 */
function phaseHint(phase: Phase, missing: string[]): string {
  switch (phase) {
    case 'orient':
      return 'Next: clarify scope, then edit; keep lean unless risk triggers.';
    case 'change':
      return 'Next: finish edits, then run targeted checks before /finish.';
    case 'prove':
      return missing.length > 0
        ? `Next: satisfy checks due (${missing.join(', ')}) then /finish.`
        : 'Next: checks look complete; /finish when ready.';
    case 'close':
      return 'Next: run is closing; /record only if worth keeping.';
    default:
      return 'Next: continue the run; escalate only on risk.';
  }
}

/**
 * 构建紧凑的 Skeg 运行上下文。
 * @param run 当前 run（可空）
 * @param config 配置
 * @param cwd 项目根
 * @returns 注入文本
 */
export function buildInjectContext(
  run: RunState | null,
  config: SkegConfig,
  cwd: string,
): string {
  if (!run || run.status === 'done' || run.status === 'abandoned') {
    return [
      'Skeg: idle. Use /run <intent> to start a run.',
      'Workflow: Orient → Change → Prove → Close.',
      'Default lean: no design artifacts, no subagents, targeted checks + diff.',
    ].join('\n');
  }

  const fresh = currentChecks(run);
  const pending = fresh.filter((c) => !c.passed).map((c) => c.name);
  const expected =
    run.risk === 'guarded' ? config.checks.guarded : config.checks.default;
  const signalRequired = run.signals
    .filter((s) => s.revision === run.revision)
    .flatMap((s) => s.requiredChecks ?? []);
  const required = [...new Set([...expected, ...signalRequired])];
  const missing = required.filter((name) => !hasFreshPass(run, name));

  const compact = config.guidance === 'compact';

  const lines = [
    'Skeg run (compact):',
    `Intent: ${run.intent}`,
    `Phase: ${run.phase} | Revision: ${run.revision} | Risk: ${run.risk} (${run.riskSource}) | Status: ${run.status}`,
    `Changed: ${run.changedFiles.slice(0, 12).join(', ') || '(none)'}`,
    `Checks done: ${fresh.map((c) => `${c.name}:${c.passed ? 'ok' : 'fail'}`).join(', ') || '(none)'}`,
    `Checks due: ${missing.join(', ') || '(none)'}`,
    `Rule: evidence must match revision ${run.revision}`,
  ];

  const signals = run.signals.filter((s) => s.revision === run.revision);
  if (signals.length > 0) {
    lines.push(`Signals: ${signals.map((s) => s.trigger).join(', ')}`);
  }

  if (run.pendingGate && !run.pendingGate.resolved) {
    lines.push(
      `PENDING GATE: ${run.pendingGate.trigger} — ${run.pendingGate.reason.split('\n')[0]}`,
    );
  }

  if (!compact) {
    lines.push(
      'Rules: prove with fresh evidence; no design docs by default; escalate only on risk.',
    );
    lines.push(phaseHint(run.phase, missing));
    if (pending.length > 0) {
      lines.push(`Failed checks: ${pending.join(', ')}`);
    }
    const summary = loadProjectSummary(cwd, 280);
    if (summary) {
      lines.push('Project:');
      lines.push(summary);
    }
    const records = selectRelevantRecords(
      cwd,
      run.intent,
      run.changedFiles,
      RECORDS_INDEX_LIMIT,
    );
    if (records.length > 0) {
      lines.push('Records (relevant):');
      for (const rec of records) {
        lines.push(`${rec.id} ${rec.title}`);
      }
    }
  } else if (pending.length > 0) {
    lines.push(`Failed checks: ${pending.join(', ')}`);
  }

  let text = lines.join('\n');
  while (estimateTokens(text) > INJECT_TOKEN_BUDGET && lines.length > 6) {
    lines.pop();
    text = lines.join('\n');
  }
  return text;
}
