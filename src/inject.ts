/**
 * 构建 before_agent_start 注入文本，目标 ≤ 800 tokens。
 */
import { loadProjectSummary } from './config.ts';
import type { RunState, SkegConfig } from './types.ts';

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

  const pending = run.checks
    .filter((c) => !c.passed)
    .map((c) => c.name);
  const expected =
    run.risk === 'guarded' ? config.checks.guarded : config.checks.default;
  const missing = expected.filter(
    (name) => !run.checks.some((c) => c.name === name && c.passed),
  );

  const lines = [
    'Skeg run (compact):',
    `Intent: ${run.intent}`,
    `Phase: ${run.phase} | Risk: ${run.risk} (${run.riskSource}) | Status: ${run.status}`,
    `Changed: ${run.changedFiles.slice(0, 12).join(', ') || '(none)'}`,
    `Checks done: ${run.checks.map((c) => `${c.name}:${c.passed ? 'ok' : 'fail'}`).join(', ') || '(none)'}`,
    `Checks due: ${missing.join(', ') || '(none)'}`,
  ];

  if (run.pendingGate && !run.pendingGate.resolved) {
    lines.push(
      `PENDING GATE: ${run.pendingGate.trigger} — ${run.pendingGate.reason}`,
    );
  }

  lines.push(
    'Rules: prove with evidence; no design docs by default; escalate only on risk.',
  );

  if (pending.length > 0) {
    lines.push(`Failed checks: ${pending.join(', ')}`);
  }

  const summary = loadProjectSummary(cwd, 280);
  if (summary) {
    lines.push('Project:');
    lines.push(summary);
  }

  let text = lines.join('\n');
  // 硬裁剪，保证注入预算
  while (estimateTokens(text) > 800 && lines.length > 6) {
    lines.pop();
    text = lines.join('\n');
  }
  return text;
}
