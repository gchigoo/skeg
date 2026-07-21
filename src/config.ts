/**
 * Skeg 配置加载与默认值。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  PROJECT_FILE,
  SKEG_DIR,
  type SkegConfig,
} from './types.ts';

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
  checks: {
    default: ['targeted-test', 'diff'],
    guarded: ['test', 'typecheck', 'lint', 'diff'],
  },
};

/**
 * 从项目根读取 `.skeg/config.json`，缺失时返回默认配置。
 * @param cwd 项目根目录
 * @returns 合并后的配置
 */
export function loadConfig(cwd: string): SkegConfig {
  const path = join(cwd, SKEG_DIR, CONFIG_FILE);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkegConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      guidance: raw.guidance ?? DEFAULT_CONFIG.guidance,
      protectedPaths: raw.protectedPaths ?? DEFAULT_CONFIG.protectedPaths,
      migrationPaths: raw.migrationPaths ?? DEFAULT_CONFIG.migrationPaths,
      dependencyFiles: raw.dependencyFiles ?? DEFAULT_CONFIG.dependencyFiles,
      authPaths: raw.authPaths ?? DEFAULT_CONFIG.authPaths,
      apiPaths: raw.apiPaths ?? DEFAULT_CONFIG.apiPaths,
      riskTriggers: {
        ...DEFAULT_CONFIG.riskTriggers,
        ...(raw.riskTriggers ?? {}),
      },
      checks: {
        default: raw.checks?.default ?? DEFAULT_CONFIG.checks.default,
        guarded: raw.checks?.guarded ?? DEFAULT_CONFIG.checks.guarded,
        // 容忍误写在顶层的 commands（dogfood 真实摩擦）
        commands:
          raw.checks?.commands ??
          (raw as { commands?: Record<string, string> }).commands ??
          DEFAULT_CONFIG.checks.commands,
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
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
