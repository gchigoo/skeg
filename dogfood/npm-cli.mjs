/**
 * 跨平台解析 npm-cli.js / npm 可执行入口。
 * 候选：npm_execpath → Windows 布局 → POSIX 布局 → 裸 npm。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * @typedef {{ kind: 'node-cli'; cli: string } | { kind: 'bin'; bin: string }} NpmInvoker
 */

/**
 * 解析 npm 调用方式。
 * @returns {NpmInvoker}
 */
export function resolveNpmInvoker() {
  const fromEnv = process.env.npm_execpath?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return { kind: 'node-cli', cli: fromEnv };
  }

  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cli of candidates) {
    if (existsSync(cli)) return { kind: 'node-cli', cli };
  }

  return {
    kind: 'bin',
    bin: process.platform === 'win32' ? 'npm.cmd' : 'npm',
  };
}

/**
 * 构造 execFileSync 的 argv：`[exec, ...args]`。
 * @param {string[]} npmArgs npm 子命令参数（如 pack --json）
 * @returns {{ file: string; args: string[]; shell?: boolean }}
 */
export function npmExecArgs(npmArgs) {
  const invoker = resolveNpmInvoker();
  if (invoker.kind === 'node-cli') {
    return { file: process.execPath, args: [invoker.cli, ...npmArgs] };
  }
  return {
    file: invoker.bin,
    args: npmArgs,
    shell: process.platform === 'win32',
  };
}
