/**
 * Extension Contract：Policy / Check / Record Provider 加载与合并。
 * 扩展可追加 Policy/Check/Record，不得引入新的核心阶段状态机。
 */
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import type { ClassifiedCheck } from './checks.ts';
import type { RecordIndexEntry } from './record.ts';
import type { ConfigDiagnostic, RiskHit, SkegConfig } from './types.ts';

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

export type RecordSelector = {
  select(ctx: {
    cwd: string;
    intent: string;
    changedFiles: string[];
  }): RecordIndexEntry[];
};

export type SkegProviderModule = {
  policies?: PolicyProvider;
  checks?: CheckProvider;
  records?: RecordSelector;
};

export type LoadedProviders = {
  policies: PolicyProvider[];
  checks: CheckProvider[];
  records: RecordSelector[];
  diagnostics: ConfigDiagnostic[];
};

const EMPTY: LoadedProviders = {
  policies: [],
  checks: [],
  records: [],
  diagnostics: [],
};

/**
 * 解析 provider 模块路径为可 import 的 URL/说明符。
 * @param cwd 项目根
 * @param spec 相对路径或包名
 * @returns import 目标
 */
export function resolveProviderSpec(cwd: string, spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;
  // 相对 / 绝对路径，或带扩展名 / 非 scoped 的路径段；@scope/name 视为包名
  const looksLikePath =
    trimmed.startsWith('.') ||
    trimmed.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /\.(m?[jt]s|c?js)$/i.test(trimmed) ||
    (!trimmed.startsWith('@') &&
      (trimmed.includes('/') || trimmed.includes('\\')));
  if (looksLikePath) {
    const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    return pathToFileURL(abs).href;
  }
  return trimmed;
}

/**
 * 加载配置中的 providers；失败写入 diagnostics，不抛出。
 * @param cwd 项目根
 * @param config 配置
 * @returns 已加载的 providers 与诊断
 */
export async function loadProviders(
  cwd: string,
  config: SkegConfig,
): Promise<LoadedProviders> {
  const specs = config.providers ?? [];
  if (specs.length === 0) return { ...EMPTY, diagnostics: [] };

  const policies: PolicyProvider[] = [];
  const checks: CheckProvider[] = [];
  const records: RecordSelector[] = [];
  const diagnostics: ConfigDiagnostic[] = [];

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const path = `providers[${i}]`;
    if (typeof spec !== 'string' || !spec.trim()) {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Expected non-empty string module path',
      });
      continue;
    }
    try {
      const target = resolveProviderSpec(cwd, spec);
      const mod = (await import(target)) as {
        default?: SkegProviderModule;
      } & SkegProviderModule;
      const bundle: SkegProviderModule = mod.default ?? mod;
      if (bundle.policies && typeof bundle.policies.inspect === 'function') {
        policies.push(bundle.policies);
      }
      if (bundle.checks && typeof bundle.checks.classify === 'function') {
        checks.push(bundle.checks);
      }
      if (bundle.records && typeof bundle.records.select === 'function') {
        records.push(bundle.records);
      }
      if (!bundle.policies && !bundle.checks && !bundle.records) {
        diagnostics.push({
          level: 'warning',
          path,
          message: `Module ${spec} exported no policies/checks/records`,
        });
      }
    } catch (err) {
      diagnostics.push({
        level: 'error',
        path,
        message: `Failed to load ${spec}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { policies, checks, records, diagnostics };
}

/**
 * 合并内置 RiskHit 与 PolicyProvider 追加命中（不可移除内置）。
 * @param builtin 内置扫描结果
 * @param action 当前动作
 * @param config 配置
 * @param policies providers
 * @returns 合并后的 hits
 */
export function mergePolicyHits(
  builtin: RiskHit[],
  action: ProviderAction,
  config: SkegConfig,
  policies: PolicyProvider[],
): RiskHit[] {
  if (policies.length === 0) return builtin;
  const extra: RiskHit[] = [];
  for (const p of policies) {
    try {
      const hits = p.inspect(action, config);
      if (Array.isArray(hits)) extra.push(...hits);
    } catch {
      // provider 异常不得阻断内置策略
    }
  }
  return [...builtin, ...extra];
}

/**
 * 内置分类为 null 时依次询问 CheckProvider（内置优先）。
 * @param command bash 命令
 * @param config 配置
 * @param builtin 内置分类结果
 * @param checks providers
 * @returns 分类结果
 */
export function classifyWithProviders(
  command: string,
  config: SkegConfig,
  builtin: ClassifiedCheck | null,
  checks: CheckProvider[],
): ClassifiedCheck | null {
  if (builtin) return builtin;
  for (const c of checks) {
    try {
      const hit = c.classify(command, config);
      if (hit) return hit;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * 若配置了 RecordSelector，用其结果替换内置相关性选择；否则 fallback。
 * @param ctx 选择上下文
 * @param selectors providers
 * @param fallback 内置选择
 * @returns records
 */
export function selectRecordsWithProviders(
  ctx: { cwd: string; intent: string; changedFiles: string[] },
  selectors: RecordSelector[],
  fallback: () => RecordIndexEntry[],
): RecordIndexEntry[] {
  if (selectors.length === 0) return fallback();
  for (const s of selectors) {
    try {
      const picked = s.select(ctx);
      if (Array.isArray(picked)) return picked;
    } catch {
      // ignore broken selector, try next
    }
  }
  return fallback();
}

/** 测试辅助：空 providers */
export function emptyProviders(): LoadedProviders {
  return { ...EMPTY, diagnostics: [] };
}

/**
 * @param cwd 项目根
 * @param relative 相对路径
 * @returns 绝对路径（供测试写 fixture）
 */
export function providerFixturePath(cwd: string, relative: string): string {
  return join(cwd, relative);
}
