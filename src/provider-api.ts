/**
 * 公共 Provider API（零构建入口：@gchigoo/skeg/provider-api）。
 * 第三方只依赖本文件导出，勿 import src/* 内部路径。
 */
import type { ClassifiedCheck } from './checks.ts';
import type { RecordIndexEntry } from './record.ts';
import type {
  EvidenceSource,
  RiskHit,
  SkegConfig,
} from './types.ts';

export const SKEG_PROVIDER_API_VERSION = 1 as const;

export type ProviderCapability = 'policy' | 'check' | 'record';

export type ProviderAction = {
  toolName: string;
  input: Record<string, unknown>;
  paths: string[];
};

export type PolicyProvider = {
  inspect(action: ProviderAction, config: SkegConfig): RiskHit[];
};

export type CheckProvider = {
  classify(command: string, config: SkegConfig): ClassifiedCheck | null;
};

/** RecordSelector 返回值：旧版数组 = 非空即 replace；新版带 mode */
export type RecordSelection =
  | RecordIndexEntry[]
  | { mode: 'augment' | 'replace'; records: RecordIndexEntry[] };

export type RecordSelector = {
  select(ctx: {
    cwd: string;
    intent: string;
    changedFiles: string[];
  }): RecordSelection;
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

export type {
  ClassifiedCheck,
  RecordIndexEntry,
  RiskHit,
  EvidenceSource,
};
