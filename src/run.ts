/**
 * RunState 创建、更新与序列化（宿主无关）。
 */
import type {
  CheckResult,
  Gate,
  Phase,
  RiskHit,
  RiskLevel,
  RiskSource,
  RunState,
} from './types.ts';

/**
 * 检测 slash 命令参数是否含 CLI flag。
 * 注意：`--flag` 不能用 `\b--flag`（`--` 前无 word boundary，永远不匹配）。
 * @param args 命令参数（不含命令名）
 * @param flag 含或不含 `--` 前缀均可，如 `force` / `--force`
 * @returns 是否命中
 */
export function hasCliFlag(args: string | undefined, flag: string): boolean {
  const name = flag.replace(/^--/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!name) return false;
  return new RegExp(`(?:^|\\s)--${name}(?:\\s|$)`).test(args || '');
}

/**
 * 创建新的 active run。
 * @param intent 用户意图
 * @param risk 初始风险等级
 * @returns 新 RunState
 */
export function createRun(
  intent: string,
  risk: RiskLevel = 'lean',
): RunState {
  const now = new Date().toISOString();
  return {
    id: `run_${Date.now().toString(36)}`,
    intent: intent.trim(),
    status: 'active',
    risk,
    riskSource: 'advisory',
    phase: 'orient',
    changedFiles: [],
    checks: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 从 session entries 中取最近一条 RunState。
 * @param entries Pi session entries
 * @returns 最近 RunState 或 null
 */
export function latestRunFromEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): RunState | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === 'custom' && entry.customType === 'skeg/run') {
      const data = entry.data as RunState | undefined;
      if (data && typeof data.id === 'string' && typeof data.intent === 'string') {
        return data;
      }
    }
  }
  return null;
}

/**
 * 是否存在未结束的 active/blocked run。
 * @param run 当前 run
 * @returns 是否仍活跃
 */
export function isOpenRun(run: RunState | null | undefined): boolean {
  return !!run && (run.status === 'active' || run.status === 'blocked');
}

/**
 * 推进阶段。
 * @param run 当前状态
 * @param phase 目标阶段
 * @returns 更新后的副本
 */
export function setPhase(run: RunState, phase: Phase): RunState {
  return touch({ ...run, phase });
}

/**
 * 记录改动文件（去重）。
 * @param run 当前状态
 * @param files 新增文件
 * @returns 更新后的副本
 */
export function addChangedFiles(run: RunState, files: string[]): RunState {
  if (files.length === 0) return run;
  const set = new Set(run.changedFiles);
  for (const f of files) set.add(f);
  return touch({ ...run, changedFiles: [...set] });
}

/**
 * 记录 check 结果（同名覆盖）。
 * @param run 当前状态
 * @param check check 结果
 * @returns 更新后的副本
 */
export function upsertCheck(run: RunState, check: CheckResult): RunState {
  const rest = run.checks.filter((c) => c.name !== check.name);
  return touch({ ...run, checks: [...rest, check] });
}

/**
 * 应用确定性风险命中：强制升级 guarded，设置 pendingGate。
 * @param run 当前状态
 * @param hit 风险命中
 * @returns 更新后的副本
 */
export function applyRiskHit(run: RunState, hit: RiskHit): RunState {
  const gate: Gate = {
    id: `gate_${Date.now().toString(36)}`,
    trigger: hit.trigger,
    reason: hit.reason,
    path: hit.path || undefined,
  };
  return touch({
    ...run,
    risk: 'guarded',
    riskSource: 'deterministic',
    status: 'blocked',
    pendingGate: gate,
  });
}

/**
 * 应用 advisory 风险自评（仅升级，不降级，不设 gate）。
 * @param run 当前状态
 * @param risk 自评等级
 * @returns 更新后的副本
 */
export function applyAdvisoryRisk(run: RunState, risk: RiskLevel): RunState {
  if (run.riskSource === 'deterministic') return run;
  if (risk === 'lean') return run;
  return touch({
    ...run,
    risk: 'guarded',
    riskSource: 'advisory',
  });
}

/**
 * 用户确认 gate 后恢复 active。
 * @param run 当前状态
 * @returns 更新后的副本
 */
export function resolveGate(run: RunState): RunState {
  if (!run.pendingGate) return run;
  return touch({
    ...run,
    status: 'active',
    pendingGate: { ...run.pendingGate, resolved: true },
  });
}

/**
 * 清除已 resolved 的 gate，允许后续新 gate。
 * @param run 当前状态
 * @returns 更新后的副本
 */
export function clearResolvedGate(run: RunState): RunState {
  if (!run.pendingGate?.resolved) return run;
  const { pendingGate: _, ...rest } = run;
  return touch(rest as RunState);
}

/**
 * 关闭 run。
 * @param run 当前状态
 * @param status done 或 abandoned
 * @returns 更新后的副本
 */
export function closeRun(
  run: RunState,
  status: 'done' | 'abandoned',
): RunState {
  return touch({
    ...run,
    status,
    phase: 'close',
    pendingGate: undefined,
  });
}

/**
 * 格式化 /status 输出。
 * @param run 当前状态
 * @returns 多行文本
 */
export function formatStatus(run: RunState | null): string {
  if (!run) return 'No active Skeg run. Use /run <intent> to start.';
  const checks =
    run.checks.length === 0
      ? '(none)'
      : run.checks
          .map((c) => `${c.passed ? 'pass' : 'fail'}:${c.name}`)
          .join(', ');
  const gate = run.pendingGate
    ? `${run.pendingGate.trigger}${run.pendingGate.resolved ? ' (resolved)' : ''}: ${run.pendingGate.reason}`
    : '(none)';
  return [
    `Intent:  ${run.intent}`,
    `Status:  ${run.status}`,
    `Phase:   ${run.phase}`,
    `Risk:    ${run.risk} (${run.riskSource})`,
    `Files:   ${run.changedFiles.length === 0 ? '(none)' : run.changedFiles.join(', ')}`,
    `Checks:  ${checks}`,
    `Gate:    ${gate}`,
    `Id:      ${run.id}`,
  ].join('\n');
}

/**
 * 将 record id 记入当前 run。
 * @param run 当前状态
 * @param recordId record id
 * @returns 更新后的副本
 */
export function addRecordId(run: RunState, recordId: string): RunState {
  const ids = run.recordIds ?? [];
  if (ids.includes(recordId)) return run;
  return touch({ ...run, recordIds: [...ids, recordId] });
}

/**
 * 生成 Close 报告。
 * @param run 当前状态
 * @returns 报告文本
 */
export function formatCloseReport(run: RunState): string {
  const checks =
    run.checks.length === 0
      ? '- (no checks recorded)'
      : run.checks
          .map(
            (c) =>
              `- ${c.name}: ${c.passed ? 'pass' : 'fail'}${c.evidence ? ` (${c.evidence})` : ''}`,
          )
          .join('\n');
  const records =
    run.recordIds && run.recordIds.length > 0
      ? run.recordIds.join(', ')
      : 'none (use /record when worth keeping)';
  const heuristic =
    run.risk === 'guarded' && run.riskSource === 'advisory'
      ? '\nRisk detection: heuristic (advisory only). Consider configuring authPaths/apiPaths in .skeg/config.json.'
      : '';
  return [
    `Done: ${run.intent}`,
    '',
    'Validation:',
    checks,
    '',
    `Files changed: ${run.changedFiles.length === 0 ? '(none)' : run.changedFiles.join(', ')}`,
    `Risk: ${run.risk} (${run.riskSource})`,
    `Record: ${records}`,
    heuristic,
  ].join('\n');
}

function touch(run: RunState): RunState {
  return { ...run, updatedAt: new Date().toISOString() };
}
