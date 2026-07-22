/**
 * RunState 创建、更新与序列化（宿主无关）。
 * 状态变更委托给 reducer；本模块保留命令层友好 API。
 */
import { migrateRunState } from './migrate.ts';
import { gateFromHits, reduce } from './reducer.ts';
import type {
  CheckRun,
  Gate,
  Phase,
  RiskHit,
  RiskLevel,
  RunState,
} from './types.ts';

/**
 * 检测 slash 命令参数是否含 CLI flag。
 * @param args 命令参数（不含命令名）
 * @param flag 含或不含 `--` 前缀均可
 * @returns 是否命中
 */
export function hasCliFlag(args: string | undefined, flag: string): boolean {
  const name = flag.replace(/^--/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!name) return false;
  return new RegExp(`(?:^|\\s)--${name}(?:\\s|$)`).test(args || '');
}

/**
 * 提取 `--waive "..."` 或 `--waive reason` 理由。
 * @param args 命令参数
 * @returns 理由或 null
 */
export function parseWaiveReason(args: string | undefined): string | null {
  if (!args) return null;
  const quoted = args.match(/--waive\s+"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const single = args.match(/--waive\s+'([^']+)'/);
  if (single?.[1]) return single[1].trim();
  const bare = args.match(/--waive\s+(\S+(?:\s+(?!--)\S+)*)/);
  if (bare?.[1]) return bare[1].trim();
  return null;
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
  return reduce(null, { type: 'RUN_STARTED', intent, risk });
}

/**
 * 从 session entries 中取最近一条 RunState（自动迁移 v1）。
 * @param entries Pi session entries
 * @returns 最近 RunState 或 null
 */
export function latestRunFromEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): RunState | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === 'custom' && entry.customType === 'skeg/run') {
      const migrated = migrateRunState(entry.data);
      if (migrated) return migrated;
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
  return reduce(run, { type: 'PHASE_SET', phase });
}

/**
 * 记录改动文件并 bump revision（mutation 语义）。
 * @param run 当前状态
 * @param files 新增文件
 * @returns 更新后的副本
 */
export function addChangedFiles(run: RunState, files: string[]): RunState {
  if (files.length === 0) return run;
  return reduce(run, { type: 'MUTATION_COMMITTED', paths: files });
}

/**
 * 记录 check 结果（同名同 revision 覆盖）。
 * @param run 当前状态
 * @param check check 结果（id/revision/observedAt 可选）
 * @returns 更新后的副本
 */
export function upsertCheck(
  run: RunState,
  check: Omit<CheckRun, 'id' | 'revision' | 'observedAt'> &
    Partial<Pick<CheckRun, 'id' | 'revision' | 'observedAt'>>,
): RunState {
  return reduce(run, { type: 'CHECK_RECORDED', check });
}

/**
 * 应用确定性风险命中：强制升级 guarded，设置 pendingGate。
 * @param run 当前状态
 * @param hit 风险命中
 * @returns 更新后的副本
 */
export function applyRiskHit(run: RunState, hit: RiskHit): RunState {
  const gate = gateFromHits(
    [hit],
    hit.fingerprint
      ? `${hit.trigger}:${hit.fingerprint}`
      : `${hit.trigger}:${hit.path || ''}`,
  );
  return reduce(run, { type: 'GATE_OPENED', gate });
}

/**
 * 打开含多个 hit 的 gate。
 * @param run 当前状态
 * @param hits 命中列表
 * @param actionFingerprint 动作指纹
 * @returns 更新后的副本
 */
export function openGate(
  run: RunState,
  hits: RiskHit[],
  actionFingerprint: string,
): RunState {
  if (hits.length === 0) return run;
  return reduce(run, {
    type: 'GATE_OPENED',
    gate: gateFromHits(hits, actionFingerprint),
  });
}

/**
 * 应用 advisory 风险自评（仅升级，不降级，不设 gate）。
 * @param run 当前状态
 * @param risk 自评等级
 * @returns 更新后的副本
 */
export function applyAdvisoryRisk(run: RunState, risk: RiskLevel): RunState {
  return reduce(run, { type: 'RISK_ADVISORY', risk });
}

/**
 * 用户确认 gate 后恢复 active。
 * @param run 当前状态
 * @returns 更新后的副本
 */
export function resolveGate(run: RunState): RunState {
  return reduce(run, { type: 'GATE_RESOLVED', approved: true });
}

/**
 * 清除已 resolved 的 gate，允许后续新 gate。
 * @param run 当前状态
 * @returns 更新后的副本
 */
export function clearResolvedGate(run: RunState): RunState {
  return reduce(run, { type: 'GATE_CLEARED' });
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
  return reduce(run, { type: 'RUN_FINISHED', status });
}

/**
 * 当前 revision 下有效（非 stale）的 checks。
 * @param run 当前状态
 * @returns 当前 revision 的 checks
 */
export function currentChecks(run: RunState): CheckRun[] {
  return run.checks.filter((c) => c.revision === run.revision);
}

/**
 * 判断某 check 名在当前 revision 是否已通过。
 * @param run 当前状态
 * @param name check 名
 * @returns 是否通过
 */
export function hasFreshPass(run: RunState, name: string): boolean {
  return currentChecks(run).some((c) => c.name === name && c.passed);
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
          .map((c) => {
            const stale = c.revision !== run.revision;
            const mark = c.passed ? 'pass' : 'fail';
            const src =
              c.source && c.source !== 'builtin' ? `/${c.source}` : '';
            return stale
              ? `${mark}:${c.name}@r${c.revision}${src}(stale)`
              : `${mark}:${c.name}@r${c.revision}${src}`;
          })
          .join(', ');
  const gate = run.pendingGate
    ? `${run.pendingGate.trigger}${run.pendingGate.resolved ? ' (resolved)' : ''}: ${run.pendingGate.reason}`
    : '(none)';
  const signals =
    run.signals.filter((s) => s.revision === run.revision).length === 0
      ? '(none)'
      : run.signals
          .filter((s) => s.revision === run.revision)
          .map((s) => s.trigger)
          .join(', ');
  const pre =
    run.preExistingFiles && run.preExistingFiles.length > 0
      ? run.preExistingFiles.join(', ')
      : '(none)';
  const gateSources = (run.pendingGate?.hits ?? [])
    .map((h) => h.source)
    .filter((s) => s && s !== 'builtin');
  const uniqueSources = [...new Set(gateSources)];
  const lines = [
    `Intent:  ${run.intent}`,
    `Status:  ${run.status}`,
    `Phase:   ${run.phase}`,
    `Revision:${run.revision}`,
    `Risk:    ${run.risk} (${run.riskSource})`,
    `Files:   ${run.changedFiles.length === 0 ? '(none)' : run.changedFiles.join(', ')}`,
    `Pre-existing: ${pre}`,
    `Checks:  ${checks}`,
    `Signals: ${signals}`,
    `Gate:    ${gate}`,
  ];
  if (uniqueSources.length > 0) {
    lines.push(`Sources: ${uniqueSources.join(', ')}`);
  }
  lines.push(`Id:      ${run.id}`);
  return lines.join('\n');
}

/**
 * 将 record id 记入当前 run。
 * @param run 当前状态
 * @param recordId record id
 * @returns 更新后的副本
 */
export function addRecordId(run: RunState, recordId: string): RunState {
  return reduce(run, { type: 'RECORD_ADDED', recordId });
}

/**
 * 生成 Close 报告。
 * @param run 当前状态
 * @returns 报告文本
 */
export function formatCloseReport(run: RunState): string {
  const fresh = currentChecks(run);
  const checks =
    fresh.length === 0
      ? '- (no fresh checks recorded)'
      : fresh
          .map(
            (c) =>
              `- ${c.name}: ${c.passed ? 'pass' : 'fail'}${c.evidence ? ` (${c.evidence})` : ''}`,
          )
          .join('\n');
  const records =
    run.recordIds && run.recordIds.length > 0
      ? run.recordIds.join(', ')
      : 'none (use /record when worth keeping)';
  const waivers =
    run.waivers.filter((w) => w.revision === run.revision).length === 0
      ? ''
      : `\nWaivers:\n${run.waivers
          .filter((w) => w.revision === run.revision)
          .map((w) => `- ${w.reason} (skipped: ${w.missingChecks.join(', ') || 'n/a'})`)
          .join('\n')}`;
  const heuristic =
    run.risk === 'guarded' && run.riskSource === 'advisory'
      ? '\nRisk detection: heuristic (advisory only). Consider configuring authPaths/apiPaths in .skeg/config.json.'
      : '';
  return [
    `Done: ${run.intent}`,
    '',
    `Revision: ${run.revision}`,
    '',
    'Validation:',
    checks,
    '',
    `Files changed: ${run.changedFiles.length === 0 ? '(none)' : run.changedFiles.join(', ')}`,
    `Risk: ${run.risk} (${run.riskSource})`,
    `Record: ${records}`,
    heuristic,
    waivers,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * 当前 pending gate（若有）。
 * @param run 当前状态
 * @returns gate 或 undefined
 */
export function getPendingGate(run: RunState): Gate | undefined {
  return run.pendingGate && !run.pendingGate.resolved
    ? run.pendingGate
    : undefined;
}
