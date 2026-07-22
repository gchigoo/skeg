#!/usr/bin/env node
/**
 * Skeg token / LOC / 表面预算检查脚本（零依赖）。
 *
 * 用法：
 *   node scripts/check-budgets.mjs                     # 全部预算
 *   node scripts/check-budgets.mjs --loc               # 仅 LOC
 *   node scripts/check-budgets.mjs <file> --budget N   # 检查单个文件 token
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const BUDGETS = [
  { pattern: 'prompts/*.md', maxTokens: 800 },
  { pattern: 'skills/**/SKILL.md', maxTokens: 1500 },
];

/** core 适配层 LOC 基线（v0.6.2+ 承认 600） */
const CORE_LOC_BUDGET = 600;
/** extensions/*.ts 合计（host-adapter 总量） */
const EXTENSIONS_TOTAL_LOC_BUDGET = 700;
/** 注入硬预算常量上限 */
const INJECT_TOKEN_BUDGET_MAX = 300;
/** core 公开 registerCommand 次数 */
const CORE_REGISTER_COMMAND_MAX = 1;
/** src/commands.ts case 标签数（含 run/start 别名） */
const COMMAND_CASE_MAX = 9;
/** reducer SkegEvent 变体数 */
const SKEG_EVENT_VARIANTS_MAX = 15;

const LOC_BUDGETS = [
  { file: 'extensions/core.ts', maxLoc: CORE_LOC_BUDGET },
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'archive']);

/**
 * 估算文本 token 数。
 * @param {string} text 待估算文本
 * @returns {number} 估算 token 数
 */
function estimateTokens(text) {
  const cjk = text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/gu) ?? [];
  const rest = text.length - cjk.length;
  return cjk.length + Math.ceil(rest / 4);
}

/**
 * 统计非空行数。
 * @param {string} text 源码
 * @returns {number} LOC
 */
function countLoc(text) {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * 将 glob 转为正则。
 * @param {string} pattern glob
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 递归收集文件相对路径。
 * @param {string} root 根目录
 * @returns {string[]}
 */
function walk(root) {
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else {
        results.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  }
  return results;
}

/**
 * 检查 token 预算。
 * @param {string} file 文件路径
 * @param {number} maxTokens 上限
 * @returns {boolean}
 */
function checkFile(file, maxTokens) {
  const tokens = estimateTokens(readFileSync(file, 'utf8'));
  const ok = tokens <= maxTokens;
  const status = ok ? 'OK  ' : 'OVER';
  console.log(`${status}  ${String(tokens).padStart(6)} / ${String(maxTokens).padEnd(6)} tokens  ${file}`);
  return ok;
}

/**
 * 检查 LOC 预算。
 * @param {string} root 根目录
 * @returns {boolean}
 */
function checkLoc(root) {
  let ok = true;
  for (const { file, maxLoc } of LOC_BUDGETS) {
    const full = join(root, file);
    try {
      const loc = countLoc(readFileSync(full, 'utf8'));
      const pass = loc <= maxLoc;
      console.log(`${pass ? 'OK  ' : 'OVER'}  ${String(loc).padStart(6)} / ${String(maxLoc).padEnd(6)} LOC     ${file}`);
      if (!pass) ok = false;
    } catch {
      console.log(`SKIP  ${'-'.padStart(6)} / ${String(maxLoc).padEnd(6)} LOC     ${file} (missing)`);
    }
  }
  return ok;
}

/**
 * 多维表面预算：extensions 总 LOC、注入 tokens、命令数、事件原语。
 * @param {string} root 根目录
 * @returns {boolean}
 */
function checkSurfaceBudgets(root) {
  let ok = true;

  // host-adapter 总 LOC
  const extDir = join(root, 'extensions');
  let extTotal = 0;
  try {
    const files = readdirSync(extDir).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      extTotal += countLoc(readFileSync(join(extDir, f), 'utf8'));
    }
    const pass = extTotal <= EXTENSIONS_TOTAL_LOC_BUDGET;
    console.log(
      `${pass ? 'OK  ' : 'OVER'}  ${String(extTotal).padStart(6)} / ${String(EXTENSIONS_TOTAL_LOC_BUDGET).padEnd(6)} LOC     extensions/*.ts (total)`,
    );
    if (!pass) ok = false;
  } catch {
    console.log('SKIP  extensions/*.ts total (missing)');
  }

  // 注入 token 常量
  try {
    const inject = readFileSync(join(root, 'src/inject.ts'), 'utf8');
    const m = inject.match(/export\s+const\s+INJECT_TOKEN_BUDGET\s*=\s*(\d+)/);
    if (!m) {
      console.log('FAIL  INJECT_TOKEN_BUDGET constant not found in src/inject.ts');
      ok = false;
    } else {
      const value = Number(m[1]);
      const pass = value <= INJECT_TOKEN_BUDGET_MAX;
      console.log(
        `${pass ? 'OK  ' : 'OVER'}  ${String(value).padStart(6)} / ${String(INJECT_TOKEN_BUDGET_MAX).padEnd(6)} tokens  INJECT_TOKEN_BUDGET`,
      );
      if (!pass) ok = false;
    }
  } catch {
    console.log('SKIP  INJECT_TOKEN_BUDGET (missing inject.ts)');
  }

  // core registerCommand 次数
  try {
    const core = readFileSync(join(root, 'extensions/core.ts'), 'utf8');
    const count = (core.match(/registerCommand\s*\(/g) ?? []).length;
    const pass = count <= CORE_REGISTER_COMMAND_MAX;
    console.log(
      `${pass ? 'OK  ' : 'OVER'}  ${String(count).padStart(6)} / ${String(CORE_REGISTER_COMMAND_MAX).padEnd(6)} cmds    extensions/core.ts registerCommand`,
    );
    if (!pass) ok = false;
  } catch {
    console.log('SKIP  registerCommand count');
  }

  // commands.ts case 标签数
  try {
    const commands = readFileSync(join(root, 'src/commands.ts'), 'utf8');
    const cases = commands.match(/^\s*case\s+['"]/gm) ?? [];
    const count = cases.length;
    const pass = count <= COMMAND_CASE_MAX;
    console.log(
      `${pass ? 'OK  ' : 'OVER'}  ${String(count).padStart(6)} / ${String(COMMAND_CASE_MAX).padEnd(6)} cases   src/commands.ts`,
    );
    if (!pass) ok = false;
  } catch {
    console.log('SKIP  command case count');
  }

  // SkegEvent 变体数
  try {
    const reducer = readFileSync(join(root, 'src/reducer.ts'), 'utf8');
    const variants = reducer.match(/\{\s*type:\s*'[A-Z_]+'/g) ?? [];
    const count = variants.length;
    const pass = count <= SKEG_EVENT_VARIANTS_MAX;
    console.log(
      `${pass ? 'OK  ' : 'OVER'}  ${String(count).padStart(6)} / ${String(SKEG_EVENT_VARIANTS_MAX).padEnd(6)} events  src/reducer.ts SkegEvent`,
    );
    if (!pass) ok = false;
  } catch {
    console.log('SKIP  SkegEvent variants');
  }

  return ok;
}

/**
 * 示例 Provider 只能依赖公共 provider-api，禁止内部 src/* 导入。
 * @param {string} root 根目录
 * @returns {boolean}
 */
function checkProviderApiBoundary(root) {
  const providersRoot = join(root, 'examples', 'providers');
  let files;
  try {
    files = walk(providersRoot).filter((f) => /\.(mjs|js|ts|cts|mts)$/.test(f));
  } catch {
    console.log('SKIP  examples/providers (missing)');
    return true;
  }

  let ok = true;
  // 禁止：相对/绝对路径指向 src、裸 import 内部模块；允许 JSDoc 中的 @gchigoo/skeg/provider-api
  const forbidden =
    /(?:from\s+|import\s*\(|import\s+[^;]*?['"])(?:\.?\.?\/)*(?:src\/|@gchigoo\/skeg\/(?!provider-api)[^'"]+)/;

  for (const rel of files) {
    const full = join(providersRoot, rel);
    const text = readFileSync(full, 'utf8');
    const display = `examples/providers/${rel}`;
    if (forbidden.test(text)) {
      console.log(`FAIL  provider API boundary  ${display}`);
      ok = false;
    } else {
      console.log(`OK    provider API boundary  ${display}`);
    }
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  let failed = false;
  const root = process.cwd();

  if (args.includes('--loc')) {
    failed = !checkLoc(root) || !checkSurfaceBudgets(root);
  } else {
    const budgetFlag = args.indexOf('--budget');
    if (budgetFlag !== -1) {
      const file = args.find((a) => !a.startsWith('--') && a !== args[budgetFlag + 1]);
      const max = Number(args[budgetFlag + 1]);
      if (!file || !Number.isFinite(max)) {
        console.error('用法: node scripts/check-budgets.mjs <file> --budget N');
        process.exit(2);
      }
      failed = !checkFile(file, max);
    } else {
      const files = walk(root);
      for (const { pattern, maxTokens } of BUDGETS) {
        const regex = globToRegExp(pattern);
        const matched = files.filter((f) => regex.test(f));
        if (matched.length === 0) {
          console.log(`SKIP  ${'-'.padStart(6)} / ${String(maxTokens).padEnd(6)} tokens  ${pattern} (no files matched)`);
          continue;
        }
        for (const f of matched) {
          if (!checkFile(join(root, f), maxTokens)) failed = true;
        }
      }
      if (!checkLoc(root)) failed = true;
      if (!checkSurfaceBudgets(root)) failed = true;
      if (!checkProviderApiBoundary(root)) failed = true;
    }
  }

  if (failed) {
    console.error('\nBudget check failed.');
    process.exit(1);
  }
  console.log('\nBudget check passed.');
}

main();
