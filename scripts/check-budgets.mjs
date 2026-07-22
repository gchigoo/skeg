#!/usr/bin/env node
/**
 * Skeg token / LOC 预算检查脚本（零依赖）。
 *
 * 用法：
 *   node scripts/check-budgets.mjs                     # token + LOC
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

const LOC_BUDGETS = [
  { file: 'extensions/core.ts', maxLoc: 500 },
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

function main() {
  const args = process.argv.slice(2);
  let failed = false;
  const root = process.cwd();

  if (args.includes('--loc')) {
    failed = !checkLoc(root);
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
    }
  }

  if (failed) {
    console.error('\nBudget check failed.');
    process.exit(1);
  }
  console.log('\nBudget check passed.');
}

main();
