/**
 * Evidence Report V1：稳定只读 JSON（CI / 外部工具）。
 */
import { configContractHash } from './contract.ts';
import type { RunState, VeritackConfig } from './types.ts';

export type EvidenceReportV1 = {
  schemaVersion: 1;
  runId: string | null;
  intent: string | null;
  status: string | null;
  phase: string | null;
  revision: number | null;
  risk: string | null;
  contractHash: string | null;
  changedFiles: string[];
  checks: Array<{
    name: string;
    kind: string;
    passed: boolean;
    revision: number;
    source?: string;
    command?: string;
  }>;
  signals: Array<{
    trigger: string;
    strength: string;
    revision: number;
    requiredChecks?: string[];
    requiresGate?: boolean;
    acknowledged?: boolean;
  }>;
  gates: Array<{
    id: string;
    trigger: string;
    status: string;
    scope: string;
  }>;
  waivers: Array<{
    reason: string;
    missingChecks: string[];
    revision: number;
  }>;
  generatedAt: string;
};

/**
 * 构建 evidence report；无 run 时字段为 null / 空数组。
 * @param run 当前 run
 * @param config 配置（用于 contractHash 回退）
 * @param generatedAt 可选时间戳
 * @returns EvidenceReportV1
 */
export function buildEvidenceReportV1(
  run: RunState | null,
  config: VeritackConfig,
  generatedAt?: string,
): EvidenceReportV1 {
  const at = generatedAt ?? new Date().toISOString();
  if (!run) {
    return {
      schemaVersion: 1,
      runId: null,
      intent: null,
      status: null,
      phase: null,
      revision: null,
      risk: null,
      contractHash: null,
      changedFiles: [],
      checks: [],
      signals: [],
      gates: [],
      waivers: [],
      generatedAt: at,
    };
  }

  return {
    schemaVersion: 1,
    runId: run.id,
    intent: run.intent,
    status: run.status,
    phase: run.phase,
    revision: run.revision,
    risk: run.risk,
    contractHash: run.contract?.configHash ?? configContractHash(config),
    changedFiles: [...run.changedFiles],
    checks: run.checks.map((c) => ({
      name: c.name,
      kind: c.kind,
      passed: c.passed,
      revision: c.revision,
      source: c.source,
      command: c.command,
    })),
    signals: run.signals.map((s) => ({
      trigger: s.trigger,
      strength: s.strength,
      revision: s.revision,
      requiredChecks: s.requiredChecks,
      requiresGate: s.requiresGate,
      acknowledged: s.acknowledged,
    })),
    gates: run.gates.map((g) => ({
      id: g.id,
      trigger: g.trigger,
      status: g.status,
      scope: g.scope,
    })),
    waivers: run.waivers.map((w) => ({
      reason: w.reason,
      missingChecks: [...w.missingChecks],
      revision: w.revision,
    })),
    generatedAt: at,
  };
}
