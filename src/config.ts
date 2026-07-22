/**
 * Skeg 配置加载与默认值（含诊断与 last-known-good）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCheckMatcher } from './checkspec.ts';
import {
  CONFIG_FILE,
  PROJECT_FILE,
  SKEG_DIR,
  type CheckMatcher,
  type ConfigDiagnostic,
  type ConfigLoadResult,
  type PolicyAction,
  type ProviderConfigEntry,
  type RiskLevel,
  type SkegConfig,
  type TriggerId,
  type TriggerPolicy,
} from './types.ts';

const TRIGGER_IDS: TriggerId[] = [
  'protectedPaths',
  'dangerousCommand',
  'databaseMigration',
  'dependencyChange',
  'publicApiChange',
  'authChange',
  'controlPlane',
];

/** 默认 policies：全部 confirm + guarded */
export const DEFAULT_POLICIES: Record<TriggerId, TriggerPolicy> = {
  protectedPaths: { risk: 'guarded', action: 'confirm' },
  dangerousCommand: { risk: 'guarded', action: 'confirm' },
  databaseMigration: { risk: 'guarded', action: 'confirm' },
  dependencyChange: { risk: 'guarded', action: 'confirm' },
  publicApiChange: { risk: 'guarded', action: 'confirm' },
  authChange: { risk: 'guarded', action: 'confirm' },
  /** 控制面：硬编码 confirm，用户覆盖被忽略 */
  controlPlane: { risk: 'guarded', action: 'confirm' },
};

/** 默认配置，与 templates/config.json 保持一致。 */
export const DEFAULT_CONFIG: SkegConfig = {
  defaultPolicy: 'lean',
  guidance: 'standard',
  protectedPaths: ['.env*', 'infra/prod/**'],
  migrationPaths: ['migrations/**', '**/migrations/**', '*.sql', '**/*.sql'],
  dependencyFiles: [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ],
  authPaths: [],
  apiPaths: [],
  policies: { ...DEFAULT_POLICIES },
  checks: {
    default: ['targeted-test', 'diff'],
    guarded: ['test', 'typecheck', 'lint', 'diff'],
  },
};

/** session 级 last-known-good，按 cwd 缓存 */
const lastKnownGood = new Map<string, SkegConfig>();

/**
 * 从项目根读取配置（兼容旧 API，忽略诊断）。
 * @param cwd 项目根目录
 * @returns 合并后的配置
 */
export function loadConfig(cwd: string): SkegConfig {
  return loadConfigWithDiagnostics(cwd).config;
}

/**
 * 加载配置并返回诊断。
 * @param cwd 项目根目录
 * @returns ConfigLoadResult
 */
export function loadConfigWithDiagnostics(cwd: string): ConfigLoadResult {
  const path = join(cwd, SKEG_DIR, CONFIG_FILE);
  if (!existsSync(path)) {
    const config = cloneConfig(DEFAULT_CONFIG);
    lastKnownGood.set(cwd, config);
    return { config, source: 'default', diagnostics: [] };
  }

  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    return fallbackWithWarning(
      cwd,
      'file',
      `Cannot read config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return fallbackWithWarning(
      cwd,
      '',
      `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fallbackWithWarning(cwd, '', 'Config root must be a JSON object');
  }

  const raw = parsed as Record<string, unknown>;
  const diagnostics: ConfigDiagnostic[] = [];
  const config = mergeConfig(raw, diagnostics);
  lastKnownGood.set(cwd, cloneConfig(config));
  return { config, source: 'project', diagnostics };
}

/**
 * 合并 raw JSON 与默认值，收集字段诊断。
 * @param raw 原始对象
 * @param diagnostics 诊断输出
 * @returns 配置
 */
function mergeConfig(
  raw: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
): SkegConfig {
  const strArr = (key: string, fallback: string[]): string[] => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      diagnostics.push({
        level: 'warning',
        path: key,
        message: `Expected string[]; using default`,
      });
      return fallback;
    }
    return v as string[];
  };

  const policies = resolvePolicies(raw, diagnostics);

  const checksRaw =
    raw.checks && typeof raw.checks === 'object'
      ? (raw.checks as Record<string, unknown>)
      : {};

  return {
    defaultPolicy:
      raw.defaultPolicy === 'guarded' || raw.defaultPolicy === 'lean'
        ? raw.defaultPolicy
        : DEFAULT_CONFIG.defaultPolicy,
    guidance:
      raw.guidance === 'compact' || raw.guidance === 'standard'
        ? raw.guidance
        : DEFAULT_CONFIG.guidance,
    protectedPaths: strArr('protectedPaths', DEFAULT_CONFIG.protectedPaths),
    migrationPaths: strArr('migrationPaths', DEFAULT_CONFIG.migrationPaths),
    dependencyFiles: strArr('dependencyFiles', DEFAULT_CONFIG.dependencyFiles),
    authPaths: strArr('authPaths', DEFAULT_CONFIG.authPaths),
    apiPaths: strArr('apiPaths', DEFAULT_CONFIG.apiPaths),
    policies,
    checks: {
      default: Array.isArray(checksRaw.default)
        ? (checksRaw.default as string[])
        : DEFAULT_CONFIG.checks.default,
      guarded: Array.isArray(checksRaw.guarded)
        ? (checksRaw.guarded as string[])
        : DEFAULT_CONFIG.checks.guarded,
      commands: parseCommands(
        checksRaw.commands ?? raw.commands,
        diagnostics,
      ),
    },
    providers: parseProviders(raw.providers, diagnostics),
  };
}

/**
 * 解析 checks.commands（字符串或 CheckMatcher）。
 * @param raw 原始值
 * @param diagnostics 诊断
 * @returns commands 或 undefined
 */
function parseCommands(
  raw: unknown,
  diagnostics: ConfigDiagnostic[],
): Record<string, string | CheckMatcher> | undefined {
  if (raw === undefined) return DEFAULT_CONFIG.checks.commands;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push({
      level: 'warning',
      path: 'checks.commands',
      message: 'Expected object; ignoring',
    });
    return DEFAULT_CONFIG.checks.commands;
  }
  const out: Record<string, string | CheckMatcher> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      // v0.7+：普通子串 matcher 拒绝（error 诊断并忽略该条目）
      if (!(value.startsWith('/') && value.lastIndexOf('/') > 0)) {
        diagnostics.push({
          level: 'error',
          path: `checks.commands.${name}`,
          message:
            'Plain substring matchers are not allowed; use /regex/ or structured CheckMatcher (package-script|argv|regex)',
        });
        continue;
      }
      out[name] = value;
    } else if (isCheckMatcher(value)) {
      out[name] = value;
      if (value.kind === 'regex') {
        const issue = validateRegexPattern(value.pattern);
        if (issue) {
          diagnostics.push({
            level: 'warning',
            path: `checks.commands.${name}`,
            message: issue,
          });
        }
      }
    } else {
      diagnostics.push({
        level: 'warning',
        path: `checks.commands.${name}`,
        message: 'Expected string or CheckMatcher; skipping',
      });
    }
  }
  return out;
}

/**
 * 校验正则 pattern 复杂度限制。
 * @param pattern 模式
 * @returns 错误消息或 null
 */
function validateRegexPattern(pattern: string): string | null {
  if (!pattern) return 'regex pattern must not be empty';
  if (pattern.length > 200) return 'regex pattern exceeds 200 characters';
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const last = pattern.lastIndexOf('/');
    const flags = pattern.slice(last + 1);
    if (flags && !/^[imsu]*$/.test(flags)) {
      return 'regex flags must be a subset of imsu (g/y rejected)';
    }
  }
  return null;
}

/**
 * 解析 providers：string | { id?, spec, required?, priority? }。
 * @param raw 原始值
 * @param diagnostics 诊断
 * @returns 归一后的条目
 */
function parseProviders(
  raw: unknown,
  diagnostics: ConfigDiagnostic[],
): ProviderConfigEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({
      level: 'warning',
      path: 'providers',
      message: 'Expected array; ignoring',
    });
    return undefined;
  }
  const out: ProviderConfigEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const path = `providers[${i}]`;
    if (typeof item === 'string') {
      const spec = item.trim();
      if (!spec) {
        diagnostics.push({
          level: 'warning',
          path,
          message: 'Expected non-empty string; skipping',
        });
        continue;
      }
      out.push({ id: spec, spec, required: false, priority: 0 });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Expected string or {spec,id?,required?,priority?}; skipping',
      });
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.spec !== 'string' || !obj.spec.trim()) {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Object provider requires non-empty spec; skipping',
      });
      continue;
    }
    const spec = obj.spec.trim();
    const id =
      typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : spec;
    const required = obj.required === true;
    const priority =
      typeof obj.priority === 'number' && Number.isFinite(obj.priority)
        ? obj.priority
        : 0;
    out.push({ id, spec, required, priority });
  }
  return out;
}

/**
 * 解析 policies；旧 riskTriggers 仅告警、不再映射。
 * @param raw 原始对象
 * @param diagnostics 诊断
 * @returns policies
 */
function resolvePolicies(
  raw: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
): Record<TriggerId, TriggerPolicy> {
  const out: Record<TriggerId, TriggerPolicy> = { ...DEFAULT_POLICIES };

  if (raw.riskTriggers !== undefined) {
    diagnostics.push({
      level: 'warning',
      path: 'riskTriggers',
      message: 'riskTriggers removed in v1.0; use policies.{trigger}.{risk,action}',
    });
  }

  if (raw.policies && typeof raw.policies === 'object') {
    const policies = raw.policies as Record<string, Partial<TriggerPolicy>>;
    for (const id of TRIGGER_IDS) {
      const p = policies[id];
      if (!p || typeof p !== 'object') continue;
      // controlPlane 不可通过项目配置关闭或降级
      if (id === 'controlPlane') {
        diagnostics.push({
          level: 'warning',
          path: 'policies.controlPlane',
          message:
            'policies.controlPlane is hard-coded to confirm; override ignored',
        });
        continue;
      }
      const action = p.action;
      const risk = p.risk;
      if (action && !isPolicyAction(action)) {
        diagnostics.push({
          level: 'warning',
          path: `policies.${id}.action`,
          message: `Invalid action ${String(action)}; using default`,
        });
      }
      out[id] = {
        risk: risk === 'lean' || risk === 'guarded' ? risk : out[id].risk,
        action: isPolicyAction(action) ? action : out[id].action,
      };
    }
  }

  return out;
}

/**
 * @param action 候选
 * @returns 是否合法 PolicyAction
 */
function isPolicyAction(action: unknown): action is PolicyAction {
  return (
    action === 'ignore' ||
    action === 'observe' ||
    action === 'confirm' ||
    action === 'block'
  );
}

/**
 * JSON 错误时回退 last-known-good 或保守默认。
 * @param cwd 项目根
 * @param path JSON path
 * @param message 诊断信息
 * @returns ConfigLoadResult
 */
function fallbackWithWarning(
  cwd: string,
  path: string,
  message: string,
): ConfigLoadResult {
  const diagnostics: ConfigDiagnostic[] = [
    { level: 'error', path, message },
  ];
  const cached = lastKnownGood.get(cwd);
  if (cached) {
    diagnostics.push({
      level: 'warning',
      path: '',
      message: 'Using last-known-good config',
    });
    return {
      config: cloneConfig(cached),
      source: 'last-known-good',
      diagnostics,
    };
  }
  diagnostics.push({
    level: 'warning',
    path: '',
    message: 'Using conservative default config',
  });
  return {
    config: cloneConfig(DEFAULT_CONFIG),
    source: 'default',
    diagnostics,
  };
}

/**
 * @param config 配置
 * @returns 深拷贝
 */
function cloneConfig(config: SkegConfig): SkegConfig {
  return JSON.parse(JSON.stringify(config)) as SkegConfig;
}

/**
 * 判断 `.skeg` 是否已初始化。
 * @param cwd 项目根目录
 * @returns 是否存在 project.md 与 config.json
 */
export function isInitialized(cwd: string): boolean {
  return (
    existsSync(join(cwd, SKEG_DIR, PROJECT_FILE)) &&
    existsSync(join(cwd, SKEG_DIR, CONFIG_FILE))
  );
}

/**
 * 读取 project.md 摘要（前若干行，供注入用）。
 * @param cwd 项目根目录
 * @param maxChars 最大字符数
 * @returns 摘要文本，不存在则空串
 */
export function loadProjectSummary(cwd: string, maxChars = 400): string {
  const path = join(cwd, SKEG_DIR, PROJECT_FILE);
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * 读取某 trigger 的 policy action。
 * @param config 配置
 * @param trigger trigger id
 * @returns action
 */
export function policyAction(
  config: SkegConfig,
  trigger: TriggerId,
): PolicyAction {
  return config.policies?.[trigger]?.action ?? DEFAULT_POLICIES[trigger].action;
}
