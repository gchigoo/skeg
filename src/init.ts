/**
 * `/init`：创建最小 `.skeg/` 目录。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, PROJECT_FILE, SKEG_DIR } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, '..', 'templates');

export type InitResult = {
  created: string[];
  skipped: string[];
  message: string;
};

/**
 * 初始化 `.skeg/project.md` 与 `.skeg/config.json`。
 * @param cwd 项目根目录
 * @param force 是否覆盖已有文件
 * @returns 初始化结果
 */
export function initSkeg(cwd: string, force = false): InitResult {
  const dir = join(cwd, SKEG_DIR);
  mkdirSync(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  for (const name of [PROJECT_FILE, CONFIG_FILE]) {
    const dest = join(dir, name);
    const src = join(TEMPLATES, name);
    if (existsSync(dest) && !force) {
      skipped.push(`.skeg/${name}`);
      continue;
    }
    if (existsSync(src)) {
      copyFileSync(src, dest);
    } else {
      // 模板缺失时写内置兜底
      writeFileSync(dest, name === CONFIG_FILE ? FALLBACK_CONFIG : FALLBACK_PROJECT, 'utf8');
    }
    created.push(`.skeg/${name}`);
  }

  const message = [
    created.length > 0 ? `Created: ${created.join(', ')}` : '',
    skipped.length > 0 ? `Skipped (exists): ${skipped.join(', ')}. Use /init --force to overwrite.` : '',
    '',
    'Next: fill authPaths / apiPaths in .skeg/config.json so weak triggers become deterministic.',
    'Then: /run <intent>',
  ]
    .filter(Boolean)
    .join('\n');

  return { created, skipped, message };
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
  },
  null,
  2
)}\n`;
