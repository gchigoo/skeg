/**
 * RunState 有界压缩：保留 closure / --why 所需最小历史。
 */
import type { CheckRun, Gate, RiskSignal, RunState } from './types.ts';

/** checks 超过此数才压缩 */
export const COMPACT_CHECKS_THRESHOLD = 50;
/** signals 超过此数才压缩 */
export const COMPACT_SIGNALS_THRESHOLD = 50;
/** gates 超过此数才压缩 */
export const COMPACT_GATES_THRESHOLD = 20;
/** 已 resolved gate 最多保留条数 */
const RESOLVED_GATES_KEEP = 5;
/** 历史 check 文本截断 */
const HISTORY_TEXT_MAX = 120;

/**
 * 是否应触发压缩。
 * @param run run
 * @returns 是否超阈值
 */
export function shouldCompactRun(run: RunState): boolean {
  return (
    run.checks.length > COMPACT_CHECKS_THRESHOLD ||
    run.signals.length > COMPACT_SIGNALS_THRESHOLD ||
    run.gates.length > COMPACT_GATES_THRESHOLD
  );
}

/**
 * 超阈值则压缩，否则原样返回。
 * @param run run
 * @returns 可能压缩后的 run
 */
export function maybeCompactRun(run: RunState): RunState {
  return shouldCompactRun(run) ? compactRun(run) : run;
}

/**
 * 压缩 RunState（纯函数）。
 * 保留：当前 revision 全部 checks/signals；每名最近一次 passed 历史；
 * 每 trigger 最近一条历史 signal；pending + 最近 resolved gates。
 * @param run 原状态
 * @returns 压缩副本
 */
export function compactRun(run: RunState): RunState {
  return {
    ...run,
    checks: compactChecks(run),
    signals: compactSignals(run),
    gates: compactGates(run),
  };
}

/**
 * 压缩 checks：当前 revision 全保留 + 每名最近一次历史 pass。
 * @param run run
 * @returns checks
 */
function compactChecks(run: RunState): CheckRun[] {
  const fresh = run.checks.filter((c) => c.revision === run.revision);
  const latestPassed = new Map<string, CheckRun>();
  for (const c of run.checks) {
    if (c.revision >= run.revision) continue;
    if (!c.passed) continue;
    const prev = latestPassed.get(c.name);
    if (!prev || c.revision > prev.revision) {
      latestPassed.set(c.name, truncateCheck(c));
    }
  }
  return [...fresh, ...latestPassed.values()];
}

/**
 * 压缩 signals。
 * @param run run
 * @returns signals
 */
function compactSignals(run: RunState): RiskSignal[] {
  const fresh = run.signals.filter((s) => s.revision === run.revision);
  const freshTriggers = new Set(fresh.map((s) => s.trigger));
  const latest = new Map<string, RiskSignal>();
  for (const s of run.signals) {
    if (s.revision === run.revision) continue;
    const prev = latest.get(s.trigger);
    if (!prev || s.revision > prev.revision) latest.set(s.trigger, s);
  }
  const history = [...latest.values()].filter(
    (s) => !freshTriggers.has(s.trigger),
  );
  return [...fresh, ...history];
}

/**
 * 压缩 gates。
 * @param run run
 * @returns gates
 */
function compactGates(run: RunState): Gate[] {
  const open = run.gates.filter(
    (g) => g.status === 'pending' || !g.resolved,
  );
  const resolved = run.gates
    .filter((g) => g.resolved || g.status === 'approved' || g.status === 'denied')
    .filter((g) => !open.some((o) => o.id === g.id));
  const keptResolved = resolved.slice(-RESOLVED_GATES_KEEP);
  const ids = new Set([...open, ...keptResolved].map((g) => g.id));
  if (run.pendingGate && !ids.has(run.pendingGate.id)) {
    return [...open, ...keptResolved, run.pendingGate];
  }
  return [...open, ...keptResolved];
}

/**
 * 截断历史 check 长字段。
 * @param check check
 * @returns 截断副本
 */
function truncateCheck(check: CheckRun): CheckRun {
  const next = { ...check };
  if (next.evidence && next.evidence.length > HISTORY_TEXT_MAX) {
    next.evidence = `${next.evidence.slice(0, HISTORY_TEXT_MAX)}…`;
  }
  if (next.command && next.command.length > HISTORY_TEXT_MAX) {
    next.command = `${next.command.slice(0, HISTORY_TEXT_MAX)}…`;
  }
  return next;
}
