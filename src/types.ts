/**
 * Veritack 宿主无关核心类型（schema v2）。
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
  | 'dangerousCommand'
  | 'controlPlane';

/** 启动时冻结的验证契约（run 内不可被配置弱化） */
export type RunContract = {
  schemaVersion: 1;
  configHash: string;
  providerSetHash: string;
  defaultChecks: string[];
  guardedChecks: string[];
  createdAt: string;
};

export type DetectionStrength = 'deterministic' | 'semi' | 'weak';

export type CheckKind = 'command' | 'diff';

export type PolicyAction = 'ignore' | 'observe' | 'confirm' | 'block';

export type GateScope = 'call' | 'path' | 'run';

export type GateStatus = 'pending' | 'approved' | 'denied';

/** 证据/命中的来源标注（builtin 或第三方 Provider） */
export type EvidenceSource = 'builtin' | `provider:${string}`;

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
  /** 分类来源；缺省视为 builtin */
  source?: EvidenceSource;
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

/** agent_settled 时对 run-scoped 工作区的滚动观察值 */
export type WorkspaceObservation = {
  hash: string;
  head?: string;
  observedRevision: number;
  observedAt: string;
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
  /** 最近一次工作区滚动指纹（可选；旧 session 无此字段） */
  observation?: WorkspaceObservation;
  /** 启动时冻结的验证契约（旧 session 可缺省，回退现配置） */
  contract?: RunContract;
  createdAt: string;
  updatedAt: string;
};

/** Skill / 注入指导密度：与 risk 正交。 */
export type GuidanceDensity = 'compact' | 'standard';

export type TriggerPolicy = {
  risk: RiskLevel;
  action: PolicyAction;
};

/** 结构化 check 命令匹配器 */
export type CheckMatcher =
  | { kind: 'package-script'; script: string }
  | { kind: 'argv'; executable: string; args: string[] }
  | { kind: 'regex'; pattern: string };

export type VeritackConfig = {
  defaultPolicy: RiskLevel;
  /** 注入指导密度，默认 standard */
  guidance: GuidanceDensity;
  protectedPaths: string[];
  migrationPaths: string[];
  dependencyFiles: string[];
  authPaths: string[];
  apiPaths: string[];
  policies: Record<TriggerId, TriggerPolicy>;
  checks: {
    default: string[];
    guarded: string[];
    /**
     * 可选：check 名 → 命令匹配（字符串子串/regex，或结构化 CheckMatcher）。
     * 匹配顺序：targeted-test 启发式 → 本配置 → bare test / typecheck / lint / build。
     */
    commands?: Record<string, string | CheckMatcher>;
  };
  /** 可选：第三方 Provider（字符串或对象，加载时归一为 ProviderConfigEntry） */
  providers?: ProviderConfigEntry[];
};

export type RiskHit = {
  trigger: TriggerId;
  strength: DetectionStrength;
  path: string;
  reason: string;
  /** 危险命令等动作指纹；用于 gate acknowledgement key */
  fingerprint?: string;
  /** 命中来源；缺省视为 builtin */
  source?: EvidenceSource;
};

/** `.veritack/config.json` 中 providers[] 归一后的条目 */
export type ProviderConfigEntry = {
  id: string;
  spec: string;
  required: boolean;
  /** 数值越大越优先；默认 0 */
  priority: number;
};

export type ConfigDiagnostic = {
  level: 'error' | 'warning' | 'info';
  path: string;
  message: string;
};

export type ConfigLoadResult = {
  config: VeritackConfig;
  source: 'project' | 'default' | 'last-known-good';
  diagnostics: ConfigDiagnostic[];
};

/** Pi session custom entry type for RunState. */
export const RUN_ENTRY_TYPE = 'veritack/run';

export const VERITACK_DIR = '.veritack';
export const CONFIG_FILE = 'config.json';
export const PROJECT_FILE = 'project.md';

export const SCHEMA_VERSION = 2 as const;

export const EMPTY_BASELINE: WorkspaceBaseline = {
  capturedAt: '',
  dirtyFiles: [],
  fileFingerprints: {},
};
