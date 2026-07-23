/**
 * RunState 纯函数 reducer：所有状态变化经此产生。
 */
import { EMPTY_BASELINE, SCHEMA_VERSION, type CheckRun, type Gate, type RiskHit, type RiskLevel, type RiskSignal, type RunContract, type RunState, type Waiver, type WorkspaceBaseline } from './types.ts';

export type VeritackEvent =
  | { type: 'RUN_STARTED'; intent: string; risk: RiskLevel; baseline?: WorkspaceBaseline; contract?: RunContract; id?: string; now?: string }
  | { type: 'MUTATION_COMMITTED'; paths: string[]; now?: string }
  | { type: 'CHECK_RECORDED'; check: Omit<CheckRun, 'id' | 'revision' | 'observedAt'> & Partial<Pick<CheckRun, 'id' | 'revision' | 'observedAt'>>; now?: string }
  | { type: 'SIGNAL_RAISED'; signal: Omit<RiskSignal, 'id' | 'revision'> & Partial<Pick<RiskSignal, 'id' | 'revision'>>; now?: string }
  | { type: 'GATE_OPENED'; gate: Omit<Gate, 'id' | 'status'> & Partial<Pick<Gate, 'id' | 'status'>>; now?: string }
  | { type: 'GATE_RESOLVED'; approved: boolean; now?: string }
  | { type: 'GATE_CLEARED'; now?: string }
  | { type: 'WORKSPACE_RECONCILED'; changedFiles: string[]; preExistingFiles?: string[]; headMoved?: boolean; now?: string }
  | { type: 'WORKSPACE_OBSERVED'; hash: string; head?: string; now?: string }
  | { type: 'WAIVER_ADDED'; waiver: Omit<Waiver, 'createdAt'> & Partial<Pick<Waiver, 'createdAt'>>; now?: string }
  | { type: 'RISK_ADVISORY'; risk: RiskLevel; now?: string }
  | { type: 'PHASE_SET'; phase: RunState['phase']; now?: string }
  | { type: 'RECORD_ADDED'; recordId: string; now?: string }
  | { type: 'RUN_FINISHED'; status: 'done' | 'abandoned'; now?: string }
  | { type: 'BASELINE_SET'; baseline: WorkspaceBaseline; now?: string };

/**
 * 浅比较 RunState 是否等价（跳过 updatedAt）。
 * @param a 状态 A
 * @param b 状态 B
 * @returns 是否相同
 */
export function sameState(a: RunState | null, b: RunState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const { updatedAt: _a, ...restA } = a;
  const { updatedAt: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/**
 * 对 run 应用事件，返回新状态（不修改入参）。
 * @param run 当前状态（RUN_STARTED 时可为 null）
 * @param event 事件
 * @returns 下一状态
 */
export function reduce(run: RunState | null, event: VeritackEvent): RunState {
  const now = ('now' in event && event.now) || new Date().toISOString();

  if (event.type === 'RUN_STARTED') {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: event.id ?? `run_${Date.now().toString(36)}`,
      intent: event.intent.trim(),
      revision: 0,
      status: 'active',
      risk: event.risk,
      riskSource: 'advisory',
      phase: 'orient',
      changedFiles: [],
      checks: [],
      signals: [],
      gates: [],
      waivers: [],
      baseline: event.baseline ?? { ...EMPTY_BASELINE, capturedAt: now },
      contract: event.contract,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (!run) {
    throw new Error(`reduce: ${event.type} requires an existing run`);
  }

  switch (event.type) {
    case 'MUTATION_COMMITTED': {
      if (event.paths.length === 0) return run;
      const set = new Set(run.changedFiles);
      for (const f of event.paths) set.add(f);
      const nextPhase =
        run.phase === 'orient' || run.phase === 'prove' || run.phase === 'close'
          ? 'change'
          : run.phase;
      return touch(
        {
          ...run,
          revision: run.revision + 1,
          phase: nextPhase,
          changedFiles: [...set],
        },
        now,
      );
    }

    case 'CHECK_RECORDED': {
      const check: CheckRun = {
        id: event.check.id ?? `check_${Date.now().toString(36)}`,
        kind: event.check.kind,
        name: event.check.name,
        revision: event.check.revision ?? run.revision,
        passed: event.check.passed,
        command: event.check.command,
        exitCode: event.check.exitCode,
        evidence: event.check.evidence,
        observedAt: event.check.observedAt ?? now,
        source: event.check.source,
      };
      // 同名同 revision 覆盖；不同 revision 保留历史
      const rest = run.checks.filter(
        (c) => !(c.name === check.name && c.revision === check.revision),
      );
      return touch({ ...run, checks: [...rest, check] }, now);
    }

    case 'SIGNAL_RAISED': {
      const signal: RiskSignal = {
        id: event.signal.id ?? `signal_${Date.now().toString(36)}`,
        trigger: event.signal.trigger,
        strength: event.signal.strength,
        evidence: event.signal.evidence,
        revision: event.signal.revision ?? run.revision,
        requiredChecks: event.signal.requiredChecks,
        requiresGate: event.signal.requiresGate,
        acknowledged: event.signal.acknowledged,
      };
      const rest = run.signals.filter(
        (s) => !(s.trigger === signal.trigger && s.revision === signal.revision),
      );
      let next: RunState = { ...run, signals: [...rest, signal] };
      if (signal.strength === 'deterministic' || signal.strength === 'semi') {
        next = {
          ...next,
          risk: 'guarded',
          riskSource:
            signal.strength === 'deterministic' ? 'deterministic' : run.riskSource === 'deterministic' ? 'deterministic' : 'advisory',
        };
      }
      return touch(next, now);
    }

    case 'GATE_OPENED': {
      const gate: Gate = {
        id: event.gate.id ?? `gate_${Date.now().toString(36)}`,
        hits: event.gate.hits,
        actionFingerprint: event.gate.actionFingerprint,
        scope: event.gate.scope,
        status: event.gate.status ?? 'pending',
        trigger: event.gate.trigger,
        reason: event.gate.reason,
        path: event.gate.path,
        resolved: false,
      };
      return touch(
        {
          ...run,
          risk: 'guarded',
          riskSource: 'deterministic',
          status: 'blocked',
          pendingGate: gate,
          gates: [...run.gates.filter((g) => g.id !== gate.id), gate],
        },
        now,
      );
    }

    case 'GATE_RESOLVED': {
      if (!run.pendingGate) return run;
      const pending: Gate = {
        ...run.pendingGate,
        status: event.approved ? 'approved' : 'denied',
        resolved: event.approved,
      };
      return touch(
        {
          ...run,
          status: event.approved ? 'active' : 'blocked',
          pendingGate: pending,
          gates: run.gates.map((g) => (g.id === pending.id ? pending : g)),
        },
        now,
      );
    }

    case 'GATE_CLEARED': {
      if (!run.pendingGate?.resolved) return run;
      const { pendingGate: _, ...rest } = run;
      return touch(rest as RunState, now);
    }

    case 'WORKSPACE_RECONCILED': {
      const trulyNew = event.changedFiles.filter(
        (f) => !run.changedFiles.includes(f),
      );
      const shouldBump = trulyNew.length > 0 || !!event.headMoved;
      const set = new Set(run.changedFiles);
      for (const f of event.changedFiles) set.add(f);
      let phase = run.phase;
      if (shouldBump && phase !== 'close') {
        if (phase === 'orient' || phase === 'prove') phase = 'change';
      }
      return touch(
        {
          ...run,
          revision: shouldBump ? run.revision + 1 : run.revision,
          phase,
          changedFiles: [...set],
          preExistingFiles: event.preExistingFiles ?? run.preExistingFiles,
        },
        now,
      );
    }

    case 'WORKSPACE_OBSERVED': {
      const prev = run.observation;
      const hashChanged = !prev || prev.hash !== event.hash;
      // 首次观察只记账；hash 变且 observedRevision 仍等于当前 revision → 未记账变化
      const unaccounted =
        hashChanged &&
        !!prev &&
        prev.observedRevision === run.revision;
      const nextRevision = unaccounted ? run.revision + 1 : run.revision;
      let phase = run.phase;
      if (unaccounted && phase !== 'close') {
        if (phase === 'orient' || phase === 'prove') phase = 'change';
      }
      return touch(
        {
          ...run,
          revision: nextRevision,
          phase,
          observation: {
            hash: event.hash,
            head: event.head,
            observedRevision: nextRevision,
            observedAt: now,
          },
        },
        now,
      );
    }

    case 'WAIVER_ADDED': {
      const waiver: Waiver = {
        reason: event.waiver.reason,
        missingChecks: event.waiver.missingChecks,
        revision: event.waiver.revision,
        createdAt: event.waiver.createdAt ?? now,
      };
      return touch({ ...run, waivers: [...run.waivers, waiver] }, now);
    }

    case 'RISK_ADVISORY': {
      if (run.riskSource === 'deterministic') return run;
      if (event.risk === 'lean') return run;
      return touch(
        { ...run, risk: 'guarded', riskSource: 'advisory' },
        now,
      );
    }

    case 'PHASE_SET':
      return touch({ ...run, phase: event.phase }, now);

    case 'RECORD_ADDED': {
      const ids = run.recordIds ?? [];
      if (ids.includes(event.recordId)) return run;
      return touch({ ...run, recordIds: [...ids, event.recordId] }, now);
    }

    case 'RUN_FINISHED':
      return touch(
        {
          ...run,
          status: event.status,
          phase: 'close',
          pendingGate: undefined,
        },
        now,
      );

    case 'BASELINE_SET':
      return touch({ ...run, baseline: event.baseline }, now);

    default:
      return run;
  }
}

/**
 * 从 RiskHit 列表构造 GATE_OPENED 事件载荷。
 * @param hits 命中列表
 * @param actionFingerprint 动作指纹
 * @returns gate 字段
 */
export function gateFromHits(
  hits: RiskHit[],
  actionFingerprint: string,
): Omit<Gate, 'id' | 'status'> {
  const primary = hits[0];
  return {
    hits,
    actionFingerprint,
    scope: 'call',
    trigger: primary.trigger,
    reason: hits.map((h) => h.reason).join('\n'),
    path: primary.path || undefined,
    resolved: false,
  };
}

function touch(run: RunState, now: string): RunState {
  return { ...run, updatedAt: now };
}
