/**
 * Closure evaluator：统一判断 run 是否可标记为 done。
 */
import { currentChecks } from './run.ts';
import type { Gate, RiskSignal, RunState, SkegConfig, Waiver } from './types.ts';

export type ClosureEvaluation = {
  ok: boolean;
  missing: string[];
  failed: string[];
  stale: string[];
  openGates: Gate[];
  unresolvedSignals: RiskSignal[];
  waived: string[];
};

/**
 * 评估当前 run 是否满足关闭条件。
 * @param run 当前状态
 * @param config 配置
 * @returns 评估结果
 */
export function evaluateClosure(
  run: RunState,
  config: SkegConfig,
): ClosureEvaluation {
  const requiredFromConfig =
    run.risk === 'guarded' ? config.checks.guarded : config.checks.default;

  const requiredFromSignals = run.signals
    .filter((signal) => signal.revision === run.revision)
    .flatMap((signal) => signal.requiredChecks ?? []);

  const required = [
    ...new Set([...requiredFromConfig, ...requiredFromSignals]),
  ];

  const fresh = currentChecks(run);
  const activeWaiver = currentWaiver(run);

  const waived = new Set(activeWaiver?.missingChecks ?? []);

  const missing = required.filter(
    (name) =>
      !waived.has(name) && !fresh.some((c) => c.name === name && c.passed),
  );

  const failed = fresh
    .filter((c) => !c.passed && required.includes(c.name) && !waived.has(c.name))
    .map((c) => c.name);

  // stale：历史上曾有通过记录，但当前 revision 无新鲜通过，且仍被要求
  const stale = required.filter((name) => {
    if (waived.has(name)) return false;
    if (fresh.some((c) => c.name === name && c.passed)) return false;
    return run.checks.some(
      (c) => c.name === name && c.passed && c.revision !== run.revision,
    );
  });

  // missing 中去掉已归入 stale 的，避免重复列出
  const missingOnly = missing.filter((n) => !stale.includes(n));

  const openGates = run.gates.filter((g) => g.status === 'pending');
  if (run.pendingGate && !run.pendingGate.resolved) {
    if (!openGates.some((g) => g.id === run.pendingGate!.id)) {
      openGates.push(run.pendingGate);
    }
  }

  const unresolvedSignals = run.signals.filter(
    (s) =>
      s.revision === run.revision &&
      s.requiresGate &&
      !s.acknowledged,
  );

  const ok =
    missingOnly.length === 0 &&
    failed.length === 0 &&
    stale.length === 0 &&
    openGates.length === 0;

  return {
    ok,
    missing: missingOnly,
    failed: [...new Set(failed)],
    stale,
    openGates,
    unresolvedSignals,
    waived: [...waived],
  };
}

/**
 * 当前 revision 生效的 waiver（取最近一条）。
 * @param run 当前状态
 * @returns waiver 或 undefined
 */
export function currentWaiver(run: RunState): Waiver | undefined {
  const list = run.waivers.filter((w) => w.revision === run.revision);
  return list[list.length - 1];
}

/**
 * 格式化无法 finish 的原因。
 * @param evaluation 评估结果
 * @param run 当前 run
 * @returns 多行文本
 */
export function formatClosureFailure(
  evaluation: ClosureEvaluation,
  run: RunState,
): string {
  const lines = ['Cannot finish.', ''];
  if (evaluation.missing.length > 0) {
    lines.push('Missing:');
    for (const name of evaluation.missing) lines.push(`- ${name}`);
    lines.push('');
  }
  if (evaluation.failed.length > 0) {
    lines.push('Failed:');
    for (const name of evaluation.failed) lines.push(`- ${name}`);
    lines.push('');
  }
  if (evaluation.stale.length > 0) {
    lines.push('Stale:');
    for (const name of evaluation.stale) {
      const old = run.checks
        .filter((c) => c.name === name && c.passed)
        .sort((a, b) => b.revision - a.revision)[0];
      lines.push(
        `- ${name} passed at revision ${old?.revision ?? '?'}; current revision is ${run.revision}`,
      );
    }
    lines.push('');
  }
  if (evaluation.openGates.length > 0) {
    lines.push('Open gates:');
    for (const g of evaluation.openGates) {
      lines.push(`- ${g.trigger}: ${g.reason.split('\n')[0]}`);
    }
    lines.push('');
  }
  if (evaluation.unresolvedSignals.length > 0) {
    lines.push('Unresolved signals:');
    for (const s of evaluation.unresolvedSignals) {
      lines.push(`- ${s.trigger}: ${s.evidence}`);
    }
    lines.push('');
  }
  lines.push('Use /finish --waive "reason" to accept risk deliberately.');
  return lines.join('\n').trim();
}
