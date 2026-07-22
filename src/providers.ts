/**
 * Extension Contract：Policy / Check / Record Provider 加载与合并。
 * 扩展可追加 Policy/Check/Record，不得引入新的核心阶段状态机。
 * 加载前强制 workspace trust；未信任不 import。
 */
import type { ClassifiedCheck } from './checks.ts';
import type { RecordIndexEntry } from './record.ts';
import {
  checkProviderTrust,
  classifyProviderSpec,
  providersConfigHash,
  resolveTrustedProviderTarget,
} from './trust.ts';
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

/** 带 spec 身份的已加载 Provider，便于错误归因与 session 禁用 */
export type NamedProvider<T> = {
  spec: string;
  impl: T;
};

export type ProviderRuntimeError = {
  spec: string;
  kind: 'policy' | 'check' | 'record';
  message: string;
};

export type LoadedProviders = {
  policies: NamedProvider<PolicyProvider>[];
  checks: NamedProvider<CheckProvider>[];
  records: NamedProvider<RecordSelector>[];
  diagnostics: ConfigDiagnostic[];
  /** config.providers 稳定哈希；供 session 缓存比较 */
  configHash: string;
};

const EMPTY: LoadedProviders = {
  policies: [],
  checks: [],
  records: [],
  diagnostics: [],
  configHash: providersConfigHash(undefined),
};

/**
 * @deprecated 使用 resolveTrustedProviderTarget；保留供测试路径形态检查
 * @param cwd 项目根
 * @param spec 相对路径或包名
 * @returns import 目标或原样包名
 */
export function resolveProviderSpec(cwd: string, spec: string): string {
  const classified = classifyProviderSpec(spec);
  if (!classified.ok) return spec.trim();
  const resolved = resolveTrustedProviderTarget(cwd, spec);
  if (!resolved.ok) {
    if (classified.kind === 'package') return classified.name;
    return spec.trim();
  }
  return resolved.target;
}

/**
 * 加载配置中的 providers；未信任不 import；失败写入 diagnostics。
 * @param cwd 项目根
 * @param config 配置
 * @returns 已加载的 providers 与诊断
 */
export async function loadProviders(
  cwd: string,
  config: SkegConfig,
): Promise<LoadedProviders> {
  const specs = config.providers ?? [];
  const configHash = providersConfigHash(specs);
  if (specs.length === 0) {
    return { ...EMPTY, diagnostics: [], configHash };
  }

  const policies: NamedProvider<PolicyProvider>[] = [];
  const checks: NamedProvider<CheckProvider>[] = [];
  const records: NamedProvider<RecordSelector>[] = [];
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
    const trimmed = spec.trim();

    const classified = classifyProviderSpec(trimmed);
    if (!classified.ok) {
      diagnostics.push({
        level: 'error',
        path,
        message: classified.reason,
      });
      continue;
    }

    const trust = checkProviderTrust(cwd, trimmed);
    if (!trust.trusted) {
      diagnostics.push({
        level: 'warning',
        path,
        message: trust.detail,
      });
      continue;
    }

    const resolved = resolveTrustedProviderTarget(cwd, trimmed);
    if (!resolved.ok) {
      diagnostics.push({
        level: 'error',
        path,
        message: resolved.reason,
      });
      continue;
    }

    try {
      const mod = (await import(resolved.target)) as {
        default?: SkegProviderModule;
      } & SkegProviderModule;
      const bundle: SkegProviderModule = mod.default ?? mod;
      if (bundle.policies && typeof bundle.policies.inspect === 'function') {
        policies.push({ spec: trimmed, impl: bundle.policies });
      }
      if (bundle.checks && typeof bundle.checks.classify === 'function') {
        checks.push({ spec: trimmed, impl: bundle.checks });
      }
      if (bundle.records && typeof bundle.records.select === 'function') {
        records.push({ spec: trimmed, impl: bundle.records });
      }
      if (!bundle.policies && !bundle.checks && !bundle.records) {
        diagnostics.push({
          level: 'warning',
          path,
          message: `Module ${trimmed} exported no policies/checks/records`,
        });
      }
    } catch (err) {
      diagnostics.push({
        level: 'error',
        path,
        message: `Failed to load ${trimmed}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { policies, checks, records, diagnostics, configHash };
}

/**
 * 合并内置 RiskHit 与 PolicyProvider 追加命中（不可移除内置）。
 * @param builtin 内置扫描结果
 * @param action 当前动作
 * @param config 配置
 * @param policies providers
 * @param disabledSpecs 本 session 已禁用的 spec
 * @returns hits 与运行时错误
 */
export function mergePolicyHits(
  builtin: RiskHit[],
  action: ProviderAction,
  config: SkegConfig,
  policies: NamedProvider<PolicyProvider>[],
  disabledSpecs: ReadonlySet<string> = new Set(),
): { hits: RiskHit[]; errors: ProviderRuntimeError[] } {
  if (policies.length === 0) return { hits: builtin, errors: [] };
  const extra: RiskHit[] = [];
  const errors: ProviderRuntimeError[] = [];
  for (const p of policies) {
    if (disabledSpecs.has(p.spec)) continue;
    try {
      const hits = p.impl.inspect(action, config);
      if (Array.isArray(hits)) extra.push(...hits);
    } catch (err) {
      errors.push({
        spec: p.spec,
        kind: 'policy',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { hits: [...builtin, ...extra], errors };
}

/**
 * 内置分类为 null 时依次询问 CheckProvider（内置优先）。
 * @param command bash 命令
 * @param config 配置
 * @param builtin 内置分类结果
 * @param checks providers
 * @param disabledSpecs 本 session 已禁用的 spec
 * @returns 分类结果与运行时错误
 */
export function classifyWithProviders(
  command: string,
  config: SkegConfig,
  builtin: ClassifiedCheck | null,
  checks: NamedProvider<CheckProvider>[],
  disabledSpecs: ReadonlySet<string> = new Set(),
): { check: ClassifiedCheck | null; errors: ProviderRuntimeError[] } {
  if (builtin) return { check: builtin, errors: [] };
  const errors: ProviderRuntimeError[] = [];
  for (const c of checks) {
    if (disabledSpecs.has(c.spec)) continue;
    try {
      const hit = c.impl.classify(command, config);
      if (hit) return { check: hit, errors };
    } catch (err) {
      errors.push({
        spec: c.spec,
        kind: 'check',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { check: null, errors };
}

/**
 * RecordSelector：非空数组替换内置；空数组继续尝试后续与 fallback。
 * @param ctx 选择上下文
 * @param selectors providers
 * @param fallback 内置选择
 * @param disabledSpecs 本 session 已禁用的 spec
 * @returns records 与运行时错误
 */
export function selectRecordsWithProviders(
  ctx: { cwd: string; intent: string; changedFiles: string[] },
  selectors: NamedProvider<RecordSelector>[],
  fallback: () => RecordIndexEntry[],
  disabledSpecs: ReadonlySet<string> = new Set(),
): { records: RecordIndexEntry[]; errors: ProviderRuntimeError[] } {
  if (selectors.length === 0) {
    return { records: fallback(), errors: [] };
  }
  const errors: ProviderRuntimeError[] = [];
  for (const s of selectors) {
    if (disabledSpecs.has(s.spec)) continue;
    try {
      const picked = s.impl.select(ctx);
      // 空数组不吞掉 fallback；完整 augment/replace 语义留给 v0.6.2
      if (Array.isArray(picked) && picked.length > 0) {
        return { records: picked, errors };
      }
    } catch (err) {
      errors.push({
        spec: s.spec,
        kind: 'record',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { records: fallback(), errors };
}

/** 测试辅助：空 providers */
export function emptyProviders(): LoadedProviders {
  return { ...EMPTY, diagnostics: [], configHash: providersConfigHash(undefined) };
}

/**
 * 格式化已配置 providers 的信任与加载状态。
 * @param cwd 项目根
 * @param config 配置
 * @param loaded 当前已加载集合
 * @returns 多行文本
 */
export function formatProvidersStatus(
  cwd: string,
  config: SkegConfig,
  loaded: LoadedProviders,
): string {
  const specs = config.providers ?? [];
  if (specs.length === 0) {
    return 'No providers configured in .skeg/config.json';
  }
  const lines = ['Skeg providers:', ''];
  for (const spec of specs) {
    if (typeof spec !== 'string' || !spec.trim()) {
      lines.push('- (invalid entry)');
      continue;
    }
    const trimmed = spec.trim();
    const classified = classifyProviderSpec(trimmed);
    const trust = checkProviderTrust(cwd, trimmed);
    const loadedKinds: string[] = [];
    if (loaded.policies.some((p) => p.spec === trimmed)) loadedKinds.push('policy');
    if (loaded.checks.some((p) => p.spec === trimmed)) loadedKinds.push('check');
    if (loaded.records.some((p) => p.spec === trimmed)) loadedKinds.push('record');

    let status: string;
    if (!classified.ok) status = `invalid: ${classified.reason}`;
    else if (!trust.trusted) status = trust.detail;
    else if (loadedKinds.length === 0) status = 'trusted, not loaded (reload?)';
    else status = `trusted, loaded (${loadedKinds.join(', ')})`;

    lines.push(`- ${trimmed}`);
    lines.push(`  ${status}`);
  }
  return lines.join('\n');
}
