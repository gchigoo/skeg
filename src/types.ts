/**
 * Skeg 宿主无关核心类型。
 * 字段稳定；未来更换宿主只需替换读写层。
 */

export type RunStatus = 'active' | 'blocked' | 'done' | 'abandoned';
export type RiskLevel = 'lean' | 'guarded';
export type RiskSource = 'deterministic' | 'advisory';
export type Phase = 'orient' | 'change' | 'prove' | 'close';

export type TriggerId =
  | 'databaseMigration'
  | 'dependencyChange'
  | 'protectedPaths'
  | 'publicApiChange'
  | 'authChange'
  | 'dangerousCommand';

export type DetectionStrength = 'deterministic' | 'semi' | 'weak';

export type CheckKind = 'command' | 'diff';

export type CheckResult = {
  kind: CheckKind;
  name: string;
  passed: boolean;
  evidence?: string;
};

export type Gate = {
  id: string;
  trigger: TriggerId;
  reason: string;
  path?: string;
  resolved?: boolean;
};

export type RunState = {
  id: string;
  intent: string;
  status: RunStatus;
  risk: RiskLevel;
  riskSource: RiskSource;
  phase: Phase;
  changedFiles: string[];
  checks: CheckResult[];
  pendingGate?: Gate;
  /** 本 run 期间创建的 record id 列表 */
  recordIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type SkegConfig = {
  defaultPolicy: RiskLevel;
  protectedPaths: string[];
  migrationPaths: string[];
  dependencyFiles: string[];
  authPaths: string[];
  apiPaths: string[];
  riskTriggers: {
    dependencyChange: RiskLevel;
    publicApiChange: RiskLevel;
    databaseMigration: RiskLevel;
    authChange: RiskLevel;
  };
  checks: {
    default: string[];
    guarded: string[];
  };
};

export type RiskHit = {
  trigger: TriggerId;
  strength: DetectionStrength;
  path: string;
  reason: string;
};

/** Pi session custom entry type for RunState. */
export const RUN_ENTRY_TYPE = 'skeg/run';

export const SKEG_DIR = '.skeg';
export const CONFIG_FILE = 'config.json';
export const PROJECT_FILE = 'project.md';
