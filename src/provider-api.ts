/**
 * 公共 Provider API（正式入口：@gchigoo/skeg/provider-api）。
 * 本文件零 import、自包含；第三方勿 import src/* 内部路径。
 */

export const SKEG_PROVIDER_API_VERSION = 1 as const;

export type ProviderCapability = 'policy' | 'check' | 'record';

/** 证据/命中来源（公共 DTO） */
export type ProviderEvidenceSourceV1 = 'builtin' | `provider:${string}`;

export type ProviderTriggerIdV1 =
  | 'databaseMigration'
  | 'dependencyChange'
  | 'protectedPaths'
  | 'publicApiChange'
  | 'authChange'
  | 'dangerousCommand'
  | 'controlPlane';

export type ProviderDetectionStrengthV1 = 'deterministic' | 'semi' | 'weak';

export type ProviderRiskLevelV1 = 'lean' | 'guarded';

export type ProviderPolicyActionV1 = 'ignore' | 'observe' | 'confirm' | 'block';

export type ProviderCheckMatcherV1 =
  | { readonly kind: 'package-script'; readonly script: string }
  | { readonly kind: 'argv'; readonly executable: string; readonly args: readonly string[] }
  | { readonly kind: 'regex'; readonly pattern: string };

export type ProviderTriggerPolicyV1 = Readonly<{
  risk: ProviderRiskLevelV1;
  action: ProviderPolicyActionV1;
}>;

/** SkegConfig 公共字段只读视图（Provider 可见） */
export type ProviderConfigV1 = Readonly<{
  defaultPolicy: ProviderRiskLevelV1;
  guidance: 'compact' | 'standard';
  protectedPaths: readonly string[];
  migrationPaths: readonly string[];
  dependencyFiles: readonly string[];
  authPaths: readonly string[];
  apiPaths: readonly string[];
  policies: Readonly<Record<ProviderTriggerIdV1, ProviderTriggerPolicyV1>>;
  checks: Readonly<{
    default: readonly string[];
    guarded: readonly string[];
    commands?: Readonly<Record<string, string | ProviderCheckMatcherV1>>;
  }>;
  providers?: readonly Readonly<{
    id: string;
    spec: string;
    required: boolean;
    priority: number;
  }>[];
}>;

export type ProviderActionV1 = Readonly<{
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  paths: readonly string[];
}>;

export type ProviderRiskHitV1 = Readonly<{
  trigger: ProviderTriggerIdV1;
  strength: ProviderDetectionStrengthV1;
  path: string;
  reason: string;
  fingerprint?: string;
  source?: ProviderEvidenceSourceV1;
}>;

export type ProviderClassifiedCheckV1 = Readonly<{
  kind: 'command';
  name: string;
  source?: ProviderEvidenceSourceV1;
}>;

export type ProviderRecordEntryV1 = Readonly<{
  id: string;
  type: 'decision' | 'migration' | 'incident';
  title: string;
  createdAt: string;
  fileName: string;
}>;

export type ProviderRecordSelectionV1 =
  | readonly ProviderRecordEntryV1[]
  | Readonly<{
      mode: 'augment' | 'replace';
      records: readonly ProviderRecordEntryV1[];
    }>;

export type PolicyProvider = {
  inspect(action: ProviderActionV1, config: ProviderConfigV1): ProviderRiskHitV1[];
};

export type CheckProvider = {
  classify(
    command: string,
    config: ProviderConfigV1,
  ): ProviderClassifiedCheckV1 | null;
};

export type RecordSelector = {
  select(ctx: Readonly<{
    cwd: string;
    intent: string;
    changedFiles: readonly string[];
  }>): ProviderRecordSelectionV1;
};

export type SkegProviderV1 = {
  apiVersion: 1;
  id: string;
  capabilities: ProviderCapability[];
  policies?: PolicyProvider;
  checks?: CheckProvider;
  records?: RecordSelector;
};

/**
 * 标记并返回 Provider 定义（恒等函数，便于类型推断）。
 * @param provider V1 Provider
 * @returns 同一对象
 */
export function defineProvider(provider: SkegProviderV1): SkegProviderV1 {
  return provider;
}

/** @deprecated 使用 ProviderActionV1 */
export type ProviderAction = ProviderActionV1;
/** @deprecated 使用 ProviderRiskHitV1 */
export type RiskHit = ProviderRiskHitV1;
/** @deprecated 使用 ProviderClassifiedCheckV1 */
export type ClassifiedCheck = ProviderClassifiedCheckV1;
/** @deprecated 使用 ProviderRecordEntryV1 */
export type RecordIndexEntry = ProviderRecordEntryV1;
/** @deprecated 使用 ProviderEvidenceSourceV1 */
export type EvidenceSource = ProviderEvidenceSourceV1;
/** @deprecated 使用 ProviderRecordSelectionV1 */
export type RecordSelection = ProviderRecordSelectionV1;
