/**
 * 工作区 baseline：run 启动快照，区分本 run 变化与既有脏文件。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath } from './paths.ts';
import type { WorkspaceBaseline } from './types.ts';

export type ExecGit = (cwd: string, args: string[]) => string;

/**
 * 捕获当前工作区 baseline。
 * @param cwd 项目根
 * @param execGit 可注入 git 执行器
 * @returns baseline 快照
 */
export function captureBaseline(
  cwd: string,
  execGit: ExecGit = defaultExecGit,
): WorkspaceBaseline {
  const capturedAt = new Date().toISOString();
  let head: string | undefined;
  try {
    head = execGit(cwd, ['rev-parse', 'HEAD']).trim() || undefined;
  } catch {
    head = undefined;
  }

  const dirtyFiles = listDirtyFiles(cwd, execGit);
  const fileFingerprints: Record<string, string> = {};
  for (const file of dirtyFiles) {
    fileFingerprints[file] = fingerprintFile(cwd, file, execGit);
  }

  return { head, capturedAt, dirtyFiles, fileFingerprints };
}

/**
 * 列出相对 HEAD / 未跟踪的脏文件。
 * @param cwd 项目根
 * @param execGit git 执行器
 * @returns 归一化路径列表
 */
export function listDirtyFiles(cwd: string, execGit: ExecGit = defaultExecGit): string[] {
  try {
    const statusRaw = execGit(cwd, ['status', '--porcelain']);
    const files: string[] = [];
    for (const line of statusRaw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const pathPart = line.slice(3).split(' -> ').pop()?.trim();
      if (pathPart) files.push(normalizePath(pathPart));
    }
    return [...new Set(files)];
  } catch {
    return [];
  }
}

/**
 * 文件内容 + 可选 diff 的指纹。
 * @param cwd 项目根
 * @param relativePath 相对路径
 * @param execGit git 执行器
 * @returns hex digest
 */
export function fingerprintFile(
  cwd: string,
  relativePath: string,
  execGit: ExecGit = defaultExecGit,
): string {
  const abs = join(cwd, relativePath);
  const exists = existsSync(abs);
  let content = '';
  if (exists) {
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      content = '';
    }
  }
  let diff = '';
  try {
    diff = execGit(cwd, ['diff', 'HEAD', '--', relativePath]);
  } catch {
    diff = '';
  }
  return createHash('sha256')
    .update(exists ? '1' : '0')
    .update('\0')
    .update(content)
    .update('\0')
    .update(diff)
    .digest('hex')
    .slice(0, 16);
}

export type ReconcileResult = {
  runChanges: string[];
  preExisting: string[];
  headMoved: boolean;
  currentHead?: string;
};

/**
 * 相对 baseline 归因当前工作区变化。
 * @param cwd 项目根
 * @param baseline run 启动快照
 * @param execGit git 执行器
 * @returns 本 run 变化与既有变化
 */
export function reconcileAgainstBaseline(
  cwd: string,
  baseline: WorkspaceBaseline,
  execGit: ExecGit = defaultExecGit,
): ReconcileResult {
  let currentHead: string | undefined;
  try {
    currentHead = execGit(cwd, ['rev-parse', 'HEAD']).trim() || undefined;
  } catch {
    currentHead = undefined;
  }
  const headMoved = Boolean(
    baseline.head && currentHead && baseline.head !== currentHead,
  );

  const dirty = listDirtyFiles(cwd, execGit);
  const runChanges: string[] = [];
  const preExisting: string[] = [];

  for (const file of dirty) {
    const wasDirty = baseline.dirtyFiles.includes(file);
    if (!wasDirty) {
      runChanges.push(file);
      continue;
    }
    const fp = fingerprintFile(cwd, file, execGit);
    if (fp !== baseline.fileFingerprints[file]) {
      runChanges.push(file);
    } else {
      preExisting.push(file);
    }
  }

  // 启动时脏、现在干净：仍记为 pre-existing（已还原或提交），不进 run changes
  for (const file of baseline.dirtyFiles) {
    if (!dirty.includes(file) && !preExisting.includes(file)) {
      preExisting.push(file);
    }
  }

  return { runChanges, preExisting, headMoved, currentHead };
}

/**
 * 默认 git 执行器。
 * @param cwd 工作目录
 * @param args git 参数
 * @returns stdout
 */
function defaultExecGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
  });
}
