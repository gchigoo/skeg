/**
 * 冻结的历史 RunState fixture（迁移回归用）。
 * 勿随意改字段；新增 schema 时追加新 fixture。
 */

/** 无 schemaVersion 的 v1 完整样例 */
export const FIXTURE_V1_FULL = {
  id: 'run_v1_full',
  intent: 'migrate fixture v1',
  status: 'blocked' as const,
  risk: 'guarded' as const,
  riskSource: 'deterministic' as const,
  phase: 'change' as const,
  changedFiles: ['src/a.ts', 'migrations/001.sql'],
  checks: [
    {
      kind: 'command' as const,
      name: 'targeted-test',
      passed: true,
      evidence: 'ok',
    },
    {
      kind: 'diff' as const,
      name: 'diff',
      passed: false,
      evidence: 'protected',
    },
  ],
  pendingGate: {
    id: 'gate_legacy',
    trigger: 'databaseMigration' as const,
    reason: 'migration write',
    path: 'migrations/001.sql',
    resolved: false,
  },
  recordIds: ['rec_20260101_001'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T01:00:00.000Z',
};

/** schema v2 完整样例（含 contract / observation） */
export const FIXTURE_V2_FULL = {
  schemaVersion: 2 as const,
  id: 'run_v2_full',
  intent: 'migrate fixture v2',
  revision: 3,
  status: 'active' as const,
  risk: 'guarded' as const,
  riskSource: 'deterministic' as const,
  phase: 'prove' as const,
  changedFiles: ['src/b.ts'],
  checks: [
    {
      id: 'check_1',
      kind: 'command' as const,
      name: 'test',
      revision: 3,
      passed: true,
      observedAt: '2026-06-01T12:00:00.000Z',
      source: 'builtin' as const,
    },
  ],
  signals: [
    {
      id: 'sig_1',
      trigger: 'sensitive-keywords',
      strength: 'semi' as const,
      evidence: 'session',
      revision: 3,
      requiredChecks: ['targeted-test'],
    },
  ],
  gates: [
    {
      id: 'gate_1',
      hits: [
        {
          trigger: 'protectedPaths' as const,
          strength: 'deterministic' as const,
          path: '.env',
          reason: 'protected',
        },
      ],
      actionFingerprint: 'protectedPaths:.env',
      scope: 'call' as const,
      status: 'approved' as const,
      trigger: 'protectedPaths' as const,
      reason: 'protected',
      path: '.env',
      resolved: true,
    },
  ],
  waivers: [
    {
      reason: 'hotfix',
      missingChecks: ['lint'],
      revision: 3,
      createdAt: '2026-06-01T12:05:00.000Z',
    },
  ],
  baseline: {
    head: 'abc123',
    capturedAt: '2026-06-01T11:00:00.000Z',
    dirtyFiles: [],
    fileFingerprints: {},
  },
  observation: {
    hash: 'deadbeef',
    head: 'abc123',
    observedRevision: 3,
    observedAt: '2026-06-01T12:10:00.000Z',
  },
  contract: {
    schemaVersion: 1 as const,
    configHash: 'confighash',
    providerSetHash: 'providershash',
    defaultChecks: ['targeted-test', 'diff'],
    guardedChecks: ['test', 'typecheck', 'lint', 'diff'],
    createdAt: '2026-06-01T11:00:00.000Z',
  },
  recordIds: ['rec_20260601_001'],
  createdAt: '2026-06-01T11:00:00.000Z',
  updatedAt: '2026-06-01T12:10:00.000Z',
};
