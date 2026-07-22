/**
 * Skeg 配置加载与默认值（含诊断与 last-known-good）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  PROJECT_FILE,
  SKEG_DIR,
  type ConfigDiagnostic,
  type ConfigLoadResult,
  type PolicyAction,
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
];

/** 默认 policies：全部 confirm + guarded */
export const DEFAULT_POLICIES: Record<TriggerId, TriggerPolicy> = {
  protectedPaths: { risk: 'guarded', action: 'confirm' },
  dangerousCommand: { risk: 'guarded', action: 'confirm' },
  databaseMigration: { risk: 'guarded', action: 'confirm' },
  dependencyChange: { risk: 'guarded', action: 'confirm' },
  publicApiChange: { risk: 'guarded', action: 'confirm' },
  authChange: { risk: 'guarded', action: 'confirm' },
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
  riskTriggers: {
    dependencyChange: 'guarded',
    publicApiChange: 'guarded',
    databaseMigration: 'guarded',
    authChange: 'guarded',
  },
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
    riskTriggers: {
      ...DEFAULT_CONFIG.riskTriggers!,
      ...((raw.riskTriggers as SkegConfig['riskTriggers']) ?? {}),
    },
    policies,
    checks: {
      default: Array.isArray(checksRaw.default)
        ? (checksRaw.default as string[])
        : DEFAULT_CONFIG.checks.default,
      guarded: Array.isArray(checksRaw.guarded)
        ? (checksRaw.guarded as string[])
        : DEFAULT_CONFIG.checks.guarded,
      commands:
        (checksRaw.commands as Record<string, string> | undefined) ??
        (raw.commands as Record<string, string> | undefined) ??
        DEFAULT_CONFIG.checks.commands,
    },
  };
}

/**
 * 解析 policies；兼容旧 riskTriggers。
 * @param raw 原始对象
 * @param diagnostics 诊断
 * @returns policies
 */
function resolvePolicies(
  raw: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
): Record<TriggerId, TriggerPolicy> {
  const out: Record<TriggerId, TriggerPolicy> = { ...DEFAULT_POLICIES };

  if (raw.riskTriggers && typeof raw.riskTriggers === 'object') {
    diagnostics.push({
      level: 'info',
      path: 'riskTriggers',
      message: 'Deprecated; prefer policies.{trigger}.{risk,action}',
    });
    const rt = raw.riskTriggers as Record<string, RiskLevel>;
    for (const id of [
      'dependencyChange',
      'publicApiChange',
      'databaseMigration',
      'authChange',
    ] as const) {
      if (rt[id] === 'lean' || rt[id] === 'guarded') {
        out[id] = { ...out[id], risk: rt[id] };
      }
    }
  }

  if (raw.policies && typeof raw.policies === 'object') {
    const policies = raw.policies as Record<string, Partial<TriggerPolicy>>;
    for (const id of TRIGGER_IDS) {
      const p = policies[id];
      if (!p || typeof p !== 'object') continue;
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
