/**
 * RunState schema 迁移：v1 → v2。
 */
import {
  EMPTY_BASELINE,
  SCHEMA_VERSION,
  type CheckRun,
  type Gate,
  type RunState,
} from './types.ts';

/** 旧版（无 schemaVersion）RunState 形状 */
type RunStateV1 = {
  id: string;
  intent: string;
  status: RunState['status'];
  risk: RunState['risk'];
  riskSource: RunState['riskSource'];
  phase: RunState['phase'];
  changedFiles: string[];
  checks: Array<{
    kind: CheckRun['kind'];
    name: string;
    passed: boolean;
    evidence?: string;
  }>;
  pendingGate?: {
    id: string;
    trigger: Gate['trigger'];
    reason: string;
    path?: string;
    resolved?: boolean;
  };
  recordIds?: string[];
  createdAt: string;
  updatedAt: string;
};

/**
 * 判断对象是否像 RunState（v1 或 v2）。
 * @param data 未知数据
 * @returns 是否可迁移/使用
 */
export function looksLikeRunState(data: unknown): data is RunStateV1 | RunState {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.intent === 'string';
}

/**
 * 将任意历史 RunState 规范为 schema v2。
 * @param data session entry 中的 data
 * @returns v2 RunState 或 null
 */
export function migrateRunState(data: unknown): RunState | null {
  if (!looksLikeRunState(data)) return null;
  const raw = data as RunStateV1 & Partial<RunState>;
  if (raw.schemaVersion === SCHEMA_VERSION) {
    return normalizeV2(raw as RunState);
  }
  return migrateV1ToV2(raw as RunStateV1);
}

/**
 * v1 → v2：revision=0，旧 checks 标 revision 0，空 signals/gates/waivers/baseline。
 * @param v1 旧状态
 * @returns v2 状态
 */
export function migrateV1ToV2(v1: RunStateV1): RunState {
  const now = v1.updatedAt || new Date().toISOString();
  const checks: CheckRun[] = (v1.checks ?? []).map((c, i) => ({
    id: `check_migrated_${i}`,
    kind: c.kind,
    name: c.name,
    revision: 0,
    passed: c.passed,
    evidence: c.evidence,
    observedAt: now,
  }));

  let pendingGate: Gate | undefined;
  const gates: Gate[] = [];
  if (v1.pendingGate) {
    pendingGate = {
      id: v1.pendingGate.id,
      hits: [
        {
          trigger: v1.pendingGate.trigger,
          strength: 'deterministic',
          path: v1.pendingGate.path ?? '',
          reason: v1.pendingGate.reason,
        },
      ],
      actionFingerprint: `${v1.pendingGate.trigger}:${v1.pendingGate.path ?? ''}`,
      scope: 'call',
      status: v1.pendingGate.resolved ? 'approved' : 'pending',
      trigger: v1.pendingGate.trigger,
      reason: v1.pendingGate.reason,
      path: v1.pendingGate.path,
      resolved: v1.pendingGate.resolved,
    };
    gates.push(pendingGate);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: v1.id,
    intent: v1.intent,
    revision: 0,
    status: v1.status,
    risk: v1.risk,
    riskSource: v1.riskSource,
    phase: v1.phase,
    changedFiles: [...(v1.changedFiles ?? [])],
    checks,
    signals: [],
    gates,
    waivers: [],
    baseline: { ...EMPTY_BASELINE, capturedAt: v1.createdAt || now },
    pendingGate,
    recordIds: v1.recordIds ? [...v1.recordIds] : undefined,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
  };
}

/**
 * 补齐 v2 可选缺省字段（防部分写入）。
 * @param run 可能残缺的 v2
 * @returns 完整 v2
 */
function normalizeV2(run: RunState): RunState {
  return {
    ...run,
    schemaVersion: SCHEMA_VERSION,
    revision: typeof run.revision === 'number' ? run.revision : 0,
    checks: run.checks ?? [],
    signals: run.signals ?? [],
    gates: run.gates ?? [],
    waivers: run.waivers ?? [],
    baseline: run.baseline ?? { ...EMPTY_BASELINE, capturedAt: run.createdAt },
    changedFiles: run.changedFiles ?? [],
  };
}
