/**
 * Extension Contract：Policy / Check / Record Provider 加载与合并。
 * 扩展可追加 Policy/Check/Record，不得引入新的核心阶段状态机。
 * 加载前强制 workspace trust；未信任不 import。
 */
import type { ClassifiedCheck } from './checks.ts';
import { deepFreezeCopy, frozenConfigView } from './freeze.ts';
import {
  type CheckProvider,
  type PolicyProvider,
  type ProviderAction,
  type ProviderCapability,
  type RecordSelection,
  type RecordSelector,
  type VeritackProviderV1,
  VERITACK_PROVIDER_API_VERSION,
} from './provider-api.ts';
import {
  riskHitKey,
  validateClassifiedCheck,
  validateRecordEntries,
  validateRiskHits,
} from './providervalidate.ts';
import type { RecordIndexEntry } from './record.ts';
import {
  checkProviderTrust,
  classifyProviderSpec,
  hashProviderContent,
  loadTrustStoreWithDiagnostics,
  providersConfigHash,
  resolveTrustedProviderTarget,
} from './trust.ts';
import type {
  ConfigDiagnostic,
  ProviderConfigEntry,
  RiskHit,
  VeritackConfig,
} from './types.ts';

export type {
  CheckProvider,
  PolicyProvider,
  ProviderAction,
  RecordSelection,
  RecordSelector,
} from './provider-api.ts';

/** 带配置身份的已加载 Provider */
export type NamedProvider<T> = {
  id: string;
  spec: string;
  required: boolean;
  priority: number;
  impl: T;
};

export type ProviderRuntimeError = {
  spec: string;
  id: string;
  required: boolean;
  kind: 'policy' | 'check' | 'record';
  message: string;
};

export type RequiredPolicyFailure = {
  id: string;
  spec: string;
  reason: string;
};

export type LoadedProviders = {
  policies: NamedProvider<PolicyProvider>[];
  checks: NamedProvider<CheckProvider>[];
  records: NamedProvider<RecordSelector>[];
  diagnostics: ConfigDiagnostic[];
  configHash: string;
  /** 配置的 providers 条目（用于 status） */
  entries: ProviderConfigEntry[];
  /** required PolicyProvider 未能加载的原因 */
  requiredPolicyFailures: RequiredPolicyFailure[];
};

const EMPTY: LoadedProviders = {
  policies: [],
  checks: [],
  records: [],
  diagnostics: [],
  configHash: providersConfigHash(undefined),
  entries: [],
  requiredPolicyFailures: [],
};

/**
 * 解析模块为 Provider API v1（无 apiVersion 拒绝加载）。
 * @param mod 动态 import 结果
 * @param fallbackId 配置 id
 * @returns 归一后的 bundle 与诊断
 */
function normalizeBundle(
  mod: { default?: unknown } & Record<string, unknown>,
  fallbackId: string,
  path: string,
): {
  id: string;
  capabilities: ProviderCapability[] | null;
  policies?: PolicyProvider;
  checks?: CheckProvider;
  records?: RecordSelector;
  diagnostics: ConfigDiagnostic[];
} {
  const diagnostics: ConfigDiagnostic[] = [];
  const root = (mod.default ?? mod) as Record<string, unknown>;

  if (
    !root ||
    typeof root !== 'object' ||
    !('apiVersion' in root) ||
    root.apiVersion === undefined
  ) {
    diagnostics.push({
      level: 'error',
      path,
      message:
        'Provider must export apiVersion: 1 via defineProvider (legacy modules removed in v1.0)',
    });
    return { id: fallbackId, capabilities: [], diagnostics };
  }

  if (root.apiVersion !== VERITACK_PROVIDER_API_VERSION) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Unsupported provider apiVersion ${String(root.apiVersion)}; expected ${VERITACK_PROVIDER_API_VERSION}`,
    });
    return { id: fallbackId, capabilities: [], diagnostics };
  }
  const v1 = root as unknown as VeritackProviderV1;
  const id =
    typeof v1.id === 'string' && v1.id.trim() ? v1.id.trim() : fallbackId;

  if (!Array.isArray(v1.capabilities)) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} capabilities must be a non-empty array`,
    });
    return { id, capabilities: [], diagnostics };
  }

  const rawCaps = v1.capabilities;
  const seen = new Set<string>();
  const capabilities: ProviderCapability[] = [];
  for (const c of rawCaps) {
    if (c !== 'policy' && c !== 'check' && c !== 'record') {
      diagnostics.push({
        level: 'error',
        path,
        message: `Provider ${id} has unknown capability ${JSON.stringify(c)}`,
      });
      continue;
    }
    if (seen.has(c)) {
      diagnostics.push({
        level: 'error',
        path,
        message: `Provider ${id} has duplicate capability ${c}`,
      });
      continue;
    }
    seen.add(c);
    capabilities.push(c);
  }

  const policies =
    v1.policies && typeof v1.policies.inspect === 'function'
      ? v1.policies
      : undefined;
  const checks =
    v1.checks && typeof v1.checks.classify === 'function'
      ? v1.checks
      : undefined;
  const records =
    v1.records && typeof v1.records.select === 'function'
      ? v1.records
      : undefined;

  // 声明 ↔ 实现严格一致
  if (capabilities.includes('policy') && !policies) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} lists policy capability but exports no policies`,
    });
  }
  if (capabilities.includes('check') && !checks) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} lists check capability but exports no checks`,
    });
  }
  if (capabilities.includes('record') && !records) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} lists record capability but exports no records`,
    });
  }
  if (policies && !capabilities.includes('policy')) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} exports policies without declaring policy capability`,
    });
  }
  if (checks && !capabilities.includes('check')) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} exports checks without declaring check capability`,
    });
  }
  if (records && !capabilities.includes('record')) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} exports records without declaring record capability`,
    });
  }

  const hasError = diagnostics.some((d) => d.level === 'error');
  if (hasError) {
    // 拒载：不返回任何实现
    return { id, capabilities: [], diagnostics };
  }
  if (capabilities.length === 0) {
    diagnostics.push({
      level: 'error',
      path,
      message: `Provider ${id} capabilities must be a non-empty array`,
    });
    return { id, capabilities: [], diagnostics };
  }

  return { id, capabilities, policies, checks, records, diagnostics };
}

/**
 * 加载配置中的 providers；未信任不 import；失败写入 diagnostics。
 * @param cwd 项目根
 * @param config 配置
 * @returns 已加载的 providers 与诊断
 */
export async function loadProviders(
  cwd: string,
  config: VeritackConfig,
): Promise<LoadedProviders> {
  const entries = config.providers ?? [];
  const configHash = providersConfigHash(entries);
  const trustLoaded = loadTrustStoreWithDiagnostics();
  if (entries.length === 0) {
    return {
      ...EMPTY,
      diagnostics: [...trustLoaded.diagnostics],
      configHash,
      entries: [],
    };
  }

  const policies: NamedProvider<PolicyProvider>[] = [];
  const checks: NamedProvider<CheckProvider>[] = [];
  const records: NamedProvider<RecordSelector>[] = [];
  const diagnostics: ConfigDiagnostic[] = [...trustLoaded.diagnostics];
  const requiredPolicyFailures: RequiredPolicyFailure[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const path = `providers[${i}]`;
    const trimmed = entry.spec.trim();
    if (!trimmed) {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Expected non-empty provider spec',
      });
      continue;
    }

    const classified = classifyProviderSpec(trimmed);
    if (!classified.ok) {
      diagnostics.push({ level: 'error', path, message: classified.reason });
      if (entry.required) {
        requiredPolicyFailures.push({
          id: entry.id,
          spec: trimmed,
          reason: classified.reason,
        });
      }
      continue;
    }

    const trust = checkProviderTrust(cwd, trimmed);
    if (!trust.trusted) {
      diagnostics.push({ level: 'warning', path, message: trust.detail });
      if (entry.required) {
        requiredPolicyFailures.push({
          id: entry.id,
          spec: trimmed,
          reason: trust.detail,
        });
      }
      continue;
    }

    const resolved = resolveTrustedProviderTarget(cwd, trimmed);
    if (!resolved.ok) {
      diagnostics.push({ level: 'error', path, message: resolved.reason });
      if (entry.required) {
        requiredPolicyFailures.push({
          id: entry.id,
          spec: trimmed,
          reason: resolved.reason,
        });
      }
      continue;
    }

    // 绑定 contentHash 到 import URL，打破 ESM 缓存并收窄 TOCTOU
    const hashed = hashProviderContent(cwd, trimmed);
    if (!hashed.ok) {
      diagnostics.push({ level: 'error', path, message: hashed.reason });
      if (entry.required) {
        requiredPolicyFailures.push({
          id: entry.id,
          spec: trimmed,
          reason: hashed.reason,
        });
      }
      continue;
    }
    if (trust.trusted && trust.contentHash !== hashed.hash) {
      diagnostics.push({
        level: 'error',
        path,
        message: 'provider content changed between trust check and load',
      });
      if (entry.required) {
        requiredPolicyFailures.push({
          id: entry.id,
          spec: trimmed,
          reason: 'provider content changed between trust check and load',
        });
      }
      continue;
    }
    const importTarget = `${resolved.target}?veritack=${hashed.hash}`;

    try {
      const mod = (await import(importTarget)) as {
        default?: unknown;
      } & Record<string, unknown>;
      const bundle = normalizeBundle(mod, entry.id, path);
      diagnostics.push(...bundle.diagnostics);
      if (
        bundle.capabilities &&
        bundle.capabilities.length === 0 &&
        bundle.diagnostics.some((d) => d.level === 'error')
      ) {
        if (entry.required) {
          requiredPolicyFailures.push({
            id: entry.id,
            spec: trimmed,
            reason: bundle.diagnostics.find((d) => d.level === 'error')!.message,
          });
        }
        continue;
      }

      const meta = {
        id: bundle.id,
        spec: trimmed,
        required: entry.required,
        priority: entry.priority,
      };

      if (bundle.policies) {
        policies.push({ ...meta, impl: bundle.policies });
      } else if (
        entry.required &&
        (bundle.capabilities === null ||
          bundle.capabilities.includes('policy'))
      ) {
        // required 且声明/可能是 policy，但未导出 → 记失败
        if (bundle.capabilities?.includes('policy')) {
          requiredPolicyFailures.push({
            id: bundle.id,
            spec: trimmed,
            reason: 'required PolicyProvider missing policies export',
          });
        }
      }

      if (bundle.checks) checks.push({ ...meta, impl: bundle.checks });
      if (bundle.records) records.push({ ...meta, impl: bundle.records });

      if (!bundle.policies && !bundle.checks && !bundle.records) {
        diagnostics.push({
          level: 'warning',
          path,
          message: `Module ${trimmed} exported no policies/checks/records`,
        });
        if (entry.required) {
          requiredPolicyFailures.push({
            id: bundle.id,
            spec: trimmed,
            reason: 'required provider exported no capabilities',
          });
        }
      }
    } catch (err) {
      const message = `Failed to load ${trimmed}: ${err instanceof Error ? err.message : String(err)}`;
      diagnostics.push({ level: 'error', path, message });
      if (entry.required) {
        requiredPolicyFailures.push({
          id: entry.id,
          spec: trimmed,
          reason: message,
        });
      }
    }
  }

  // 同类型按 priority 降序、spec 字典序，保证后续遍历确定
  const byPriority = <T>(a: NamedProvider<T>, b: NamedProvider<T>) =>
    b.priority - a.priority || a.spec.localeCompare(b.spec);

  policies.sort(byPriority);
  checks.sort(byPriority);
  records.sort(byPriority);

  return {
    policies,
    checks,
    records,
    diagnostics,
    configHash,
    entries,
    requiredPolicyFailures,
  };
}

/**
 * required PolicyProvider 不可用时返回阻断原因。
 * @param loaded 已加载集合
 * @param disabledSpecs session 禁用
 * @param runtimeErrors 本轮运行时错误
 * @returns 原因或 null
 */
export function requiredPolicyUnavailable(
  loaded: LoadedProviders,
  disabledSpecs: ReadonlySet<string> = new Set(),
  runtimeErrors: ProviderRuntimeError[] = [],
): string | null {
  if (loaded.requiredPolicyFailures.length > 0) {
    const f = loaded.requiredPolicyFailures[0];
    return `required provider ${f.id} (${f.spec}): ${f.reason}`;
  }
  for (const p of loaded.policies) {
    if (p.required && disabledSpecs.has(p.spec)) {
      return `required PolicyProvider ${p.id} (${p.spec}) is disabled this session`;
    }
  }
  for (const err of runtimeErrors) {
    if (err.required && err.kind === 'policy') {
      return `required PolicyProvider ${err.id} (${err.spec}) failed: ${err.message}`;
    }
  }
  return null;
}

/**
 * 合并内置 RiskHit 与 PolicyProvider 追加命中。
 * @returns hits、errors、diagnostics
 */
export function mergePolicyHits(
  builtin: RiskHit[],
  action: ProviderAction,
  config: VeritackConfig,
  policies: NamedProvider<PolicyProvider>[],
  disabledSpecs: ReadonlySet<string> = new Set(),
): {
  hits: RiskHit[];
  errors: ProviderRuntimeError[];
  diagnostics: ConfigDiagnostic[];
} {
  const taggedBuiltin = builtin.map((h) =>
    h.source ? h : { ...h, source: 'builtin' as const },
  );
  if (policies.length === 0) {
    return { hits: taggedBuiltin, errors: [], diagnostics: [] };
  }

  const builtinKeys = new Set(taggedBuiltin.map(riskHitKey));
  const extra: RiskHit[] = [];
  const errors: ProviderRuntimeError[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const frozenConfig = frozenConfigView(config);

  for (const p of policies) {
    if (disabledSpecs.has(p.spec)) continue;
    try {
      // action 每次冻结；config 走 WeakMap 缓存
      const frozenAction = deepFreezeCopy(action);
      const raw = p.impl.inspect(frozenAction, frozenConfig);
      const validated = validateRiskHits(
        raw,
        `provider:${p.id}`,
        `provider:${p.id}.policies`,
        builtinKeys,
      );
      diagnostics.push(...validated.diagnostics);
      for (const hit of validated.hits) {
        const key = riskHitKey(hit);
        if (builtinKeys.has(key) || extra.some((e) => riskHitKey(e) === key)) {
          continue;
        }
        extra.push(hit);
      }
    } catch (err) {
      errors.push({
        spec: p.spec,
        id: p.id,
        required: p.required,
        kind: 'policy',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // builtin 优先，再按 source id 字典序
  extra.sort((a, b) => (a.source ?? '').localeCompare(b.source ?? ''));
  return { hits: [...taggedBuiltin, ...extra], errors, diagnostics };
}

/**
 * 内置分类优先；否则按 priority 询问 CheckProvider。
 */
export function classifyWithProviders(
  command: string,
  config: VeritackConfig,
  builtin: ClassifiedCheck | null,
  checks: NamedProvider<CheckProvider>[],
  disabledSpecs: ReadonlySet<string> = new Set(),
): {
  check: ClassifiedCheck | null;
  errors: ProviderRuntimeError[];
  diagnostics: ConfigDiagnostic[];
} {
  if (builtin) {
    return {
      check: builtin.source ? builtin : { ...builtin, source: 'builtin' },
      errors: [],
      diagnostics: [],
    };
  }
  const errors: ProviderRuntimeError[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  let firstHit: ClassifiedCheck | null = null;
  let firstPriority: number | null = null;
  const frozenConfig = frozenConfigView(config);

  for (const c of checks) {
    if (disabledSpecs.has(c.spec)) continue;
    try {
      const raw = c.impl.classify(command, frozenConfig);
      const validated = validateClassifiedCheck(
        raw,
        `provider:${c.id}`,
        `provider:${c.id}.checks`,
      );
      diagnostics.push(...validated.diagnostics);
      if (!validated.check) continue;
      if (!firstHit) {
        firstHit = validated.check;
        firstPriority = c.priority;
        continue;
      }
      // 同优先级且分类冲突
      if (
        firstPriority === c.priority &&
        firstHit.name !== validated.check.name
      ) {
        diagnostics.push({
          level: 'warning',
          path: `provider:${c.id}.checks`,
          message: `CheckProvider conflict at priority ${c.priority}: kept ${firstHit.name}, ignored ${validated.check.name}`,
        });
      }
    } catch (err) {
      errors.push({
        spec: c.spec,
        id: c.id,
        required: c.required,
        kind: 'check',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { check: firstHit, errors, diagnostics };
}

/**
 * 解析 RecordSelector 返回值。
 * @param picked 原始返回
 * @returns mode + records 或 null（空/无效）
 */
function parseRecordSelection(picked: unknown): {
  mode: 'augment' | 'replace';
  records: unknown;
} | null {
  if (Array.isArray(picked)) {
    if (picked.length === 0) return null;
    return { mode: 'replace', records: picked };
  }
  if (picked && typeof picked === 'object') {
    const o = picked as Record<string, unknown>;
    if (o.mode === 'augment' || o.mode === 'replace') {
      return { mode: o.mode, records: o.records };
    }
  }
  return null;
}

/**
 * RecordSelector：augment 合并；最多一个 replace；空结果回退。
 */
export function selectRecordsWithProviders(
  ctx: { cwd: string; intent: string; changedFiles: string[] },
  selectors: NamedProvider<RecordSelector>[],
  fallback: () => RecordIndexEntry[],
  disabledSpecs: ReadonlySet<string> = new Set(),
): {
  records: RecordIndexEntry[];
  errors: ProviderRuntimeError[];
  diagnostics: ConfigDiagnostic[];
} {
  if (selectors.length === 0) {
    return { records: fallback(), errors: [], diagnostics: [] };
  }
  const errors: ProviderRuntimeError[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const augmented: RecordIndexEntry[] = [];
  let replaced: RecordIndexEntry[] | null = null;
  let replaceTaken = false;
  const frozenCtx = deepFreezeCopy(ctx);

  for (const s of selectors) {
    if (disabledSpecs.has(s.spec)) continue;
    try {
      const picked = s.impl.select(frozenCtx);
      const parsed = parseRecordSelection(picked);
      if (!parsed) continue;
      const validated = validateRecordEntries(
        parsed.records,
        `provider:${s.id}.records`,
      );
      diagnostics.push(...validated.diagnostics);
      if (parsed.mode === 'replace') {
        if (replaceTaken) {
          diagnostics.push({
            level: 'warning',
            path: `provider:${s.id}.records`,
            message: 'Multiple replace RecordSelectors; keeping highest priority',
          });
          continue;
        }
        replaceTaken = true;
        replaced = validated.records;
      } else {
        for (const rec of validated.records) {
          if (!augmented.some((a) => a.id === rec.id)) augmented.push(rec);
        }
      }
    } catch (err) {
      errors.push({
        spec: s.spec,
        id: s.id,
        required: s.required,
        kind: 'record',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (replaced) {
    const merged = [...replaced];
    for (const rec of augmented) {
      if (!merged.some((m) => m.id === rec.id)) merged.push(rec);
    }
    return { records: merged.slice(0, 5), errors, diagnostics };
  }
  if (augmented.length > 0) {
    const base = fallback();
    const merged = [...base];
    for (const rec of augmented) {
      if (!merged.some((m) => m.id === rec.id)) merged.push(rec);
    }
    return { records: merged.slice(0, 5), errors, diagnostics };
  }
  return { records: fallback(), errors, diagnostics };
}

/** 测试辅助：空 providers */
export function emptyProviders(): LoadedProviders {
  return {
    ...EMPTY,
    diagnostics: [],
    configHash: providersConfigHash(undefined),
    entries: [],
    requiredPolicyFailures: [],
  };
}

/**
 * 格式化已配置 providers 的信任与加载状态。
 */
export function formatProvidersStatus(
  cwd: string,
  config: VeritackConfig,
  loaded: LoadedProviders,
): string {
  const entries = config.providers ?? [];
  if (entries.length === 0) {
    return 'No providers configured in .veritack/config.json';
  }
  const lines = ['Veritack providers:', ''];
  for (const entry of entries) {
    const trimmed = entry.spec.trim();
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

    const flags = [
      entry.required ? 'required' : 'optional',
      `priority=${entry.priority}`,
    ].join(', ');
    lines.push(`- ${entry.id} ← ${trimmed} (${flags})`);
    lines.push(`  ${status}`);
  }
  return lines.join('\n');
}
