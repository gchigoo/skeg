/**
 * `/init`：创建最小 `.veritack/` 目录。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectCommandsFromScripts } from './checkspec.ts';
import {
  CONFIG_FILE,
  PROJECT_FILE,
  VERITACK_DIR,
  type CheckMatcher,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, '..', 'templates');

export type InitResult = {
  created: string[];
  skipped: string[];
  message: string;
};

/**
 * 初始化 `.veritack/project.md` 与 `.veritack/config.json`。
 * @param cwd 项目根目录
 * @param force 是否覆盖已有文件
 * @returns 初始化结果
 */
export function initVeritack(cwd: string, force = false): InitResult {
  const dir = join(cwd, VERITACK_DIR);
  mkdirSync(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  for (const name of [PROJECT_FILE, CONFIG_FILE]) {
    const dest = join(dir, name);
    const src = join(TEMPLATES, name);
    if (existsSync(dest) && !force) {
      skipped.push(`.veritack/${name}`);
      continue;
    }
    if (existsSync(src)) {
      copyFileSync(src, dest);
    } else {
      // 模板缺失时写内置兜底
      writeFileSync(dest, name === CONFIG_FILE ? FALLBACK_CONFIG : FALLBACK_PROJECT, 'utf8');
    }
    created.push(`.veritack/${name}`);
  }

  // 从 package.json scripts 探测 checks.commands
  const detected = mergeDetectedCommands(cwd, force || created.includes(`.veritack/${CONFIG_FILE}`));

  const message = [
    created.length > 0 ? `Created: ${created.join(', ')}` : '',
    skipped.length > 0 ? `Skipped (exists): ${skipped.join(', ')}. Use /init --force to overwrite.` : '',
    detected ? `Detected check commands: ${Object.keys(detected).join(', ')}` : '',
    '',
    'Next: fill authPaths / apiPaths in .veritack/config.json so weak triggers become deterministic.',
    'Then: /veritack start <intent> (or /run <intent>)',
  ]
    .filter(Boolean)
    .join('\n');

  return { created, skipped, message };
}

/**
 * 将 package.json scripts 探测结果写入 config.checks.commands。
 * @param cwd 项目根
 * @param allowWrite 是否允许写入（新建或 --force）
 * @returns 探测到的 commands，或 null
 */
function mergeDetectedCommands(
  cwd: string,
  allowWrite: boolean,
): Record<string, CheckMatcher> | null {
  if (!allowWrite) return null;
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const detected = detectCommandsFromScripts(pkg.scripts ?? {});
    if (Object.keys(detected).length === 0) return null;
    const configPath = join(cwd, VERITACK_DIR, CONFIG_FILE);
    if (!existsSync(configPath)) return detected;
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      checks?: { commands?: Record<string, unknown> };
    };
    raw.checks = raw.checks ?? {};
    raw.checks.commands = { ...detected, ...(raw.checks.commands ?? {}) };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return detected;
  } catch {
    return null;
  }
}

/**
 * 读取模板内容（测试用）。
 * @param name 模板文件名
 * @returns 文本
 */
export function readTemplate(name: string): string {
  const path = join(TEMPLATES, name);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return name === CONFIG_FILE ? FALLBACK_CONFIG : FALLBACK_PROJECT;
}

const FALLBACK_PROJECT = `# Project

## Stack
(fill in)

## Commands
- test: (fill in)
- typecheck: (fill in)
- lint: (fill in)

## Boundaries
- Do not edit generated files.
- Database changes require guarded mode.
- Public API changes require a gate.

## Conventions
- Prefer existing abstractions.
- Add targeted regression tests for bug fixes.
`;

const FALLBACK_CONFIG = `${JSON.stringify(
  {
    defaultPolicy: 'lean',
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
    policies: {
      protectedPaths: { risk: 'guarded', action: 'confirm' },
      dangerousCommand: { risk: 'guarded', action: 'confirm' },
      databaseMigration: { risk: 'guarded', action: 'confirm' },
      dependencyChange: { risk: 'guarded', action: 'confirm' },
      publicApiChange: { risk: 'guarded', action: 'confirm' },
      authChange: { risk: 'guarded', action: 'confirm' },
      controlPlane: { risk: 'guarded', action: 'confirm' },
    },
    checks: {
      default: ['targeted-test', 'diff'],
      guarded: ['test', 'typecheck', 'lint', 'diff'],
    },
  },
  null,
  2
)}\n`;
