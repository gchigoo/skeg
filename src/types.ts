/**
 * Skeg 宿主无关核心类型（schema v2）。
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

export type PolicyAction = 'ignore' | 'observe' | 'confirm' | 'block';

export type GateScope = 'call' | 'path' | 'run';

export type GateStatus = 'pending' | 'approved' | 'denied';

/** @deprecated 使用 CheckRun；保留别名便于渐进迁移 */
export type CheckResult = CheckRun;

export type CheckRun = {
  id: string;
  kind: CheckKind;
  name: string;
  revision: number;
  passed: boolean;
  command?: string;
  exitCode?: number;
  evidence?: string;
  observedAt: string;
};

export type RiskSignal = {
  id: string;
  trigger: string;
  strength: DetectionStrength;
  evidence: string;
  revision: number;
  requiredChecks?: string[];
  requiresGate?: boolean;
  acknowledged?: boolean;
};

export type Waiver = {
  reason: string;
  missingChecks: string[];
  revision: number;
  createdAt: string;
};

export type WorkspaceBaseline = {
  head?: string;
  capturedAt: string;
  dirtyFiles: string[];
  fileFingerprints: Record<string, string>;
};

export type Gate = {
  id: string;
  hits: RiskHit[];
  actionFingerprint: string;
  scope: GateScope;
  status: GateStatus;
  /** 兼容展示：主 trigger */
  trigger: TriggerId;
  reason: string;
  path?: string;
  resolved?: boolean;
};

export type RunState = {
  schemaVersion: 2;
  id: string;
  intent: string;
  revision: number;
  status: RunStatus;
  risk: RiskLevel;
  riskSource: RiskSource;
  phase: Phase;
  changedFiles: string[];
  checks: CheckRun[];
  signals: RiskSignal[];
  gates: Gate[];
  waivers: Waiver[];
  baseline: WorkspaceBaseline;
  pendingGate?: Gate;
  /** 本 run 期间创建的 record id 列表 */
  recordIds?: string[];
  /** baseline 外的既有脏文件（展示用，不进证明范围） */
  preExistingFiles?: string[];
  createdAt: string;
  updatedAt: string;
};

/** Skill / 注入指导密度：与 risk 正交。 */
export type GuidanceDensity = 'compact' | 'standard';

export type TriggerPolicy = {
  risk: RiskLevel;
  action: PolicyAction;
};

export type SkegConfig = {
  defaultPolicy: RiskLevel;
  /** 注入指导密度，默认 standard */
  guidance: GuidanceDensity;
  protectedPaths: string[];
  migrationPaths: string[];
  dependencyFiles: string[];
  authPaths: string[];
  apiPaths: string[];
  /**
   * @deprecated 使用 policies；加载时会兼容并转成 policies
   */
  riskTriggers?: {
    dependencyChange: RiskLevel;
    publicApiChange: RiskLevel;
    databaseMigration: RiskLevel;
    authChange: RiskLevel;
  };
  policies: Record<TriggerId, TriggerPolicy>;
  checks: {
    default: string[];
    guarded: string[];
    /**
     * 可选：check 名 → 命令匹配（子串或 /regex/ 形式）。
     * 配置优先于内置启发式。
     */
    commands?: Record<string, string>;
  };
};

export type RiskHit = {
  trigger: TriggerId;
  strength: DetectionStrength;
  path: string;
  reason: string;
  /** 危险命令等动作指纹；用于 gate acknowledgement key */
  fingerprint?: string;
};

export type ConfigDiagnostic = {
  level: 'error' | 'warning' | 'info';
  path: string;
  message: string;
};

export type ConfigLoadResult = {
  config: SkegConfig;
  source: 'project' | 'default' | 'last-known-good';
  diagnostics: ConfigDiagnostic[];
};

/** Pi session custom entry type for RunState. */
export const RUN_ENTRY_TYPE = 'skeg/run';

export const SKEG_DIR = '.skeg';
export const CONFIG_FILE = 'config.json';
export const PROJECT_FILE = 'project.md';

export const SCHEMA_VERSION = 2 as const;

export const EMPTY_BASELINE: WorkspaceBaseline = {
  capturedAt: '',
  dirtyFiles: [],
  fileFingerprints: {},
};
