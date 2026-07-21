/**
 * Prove 阶段：收集 diff / 敏感关键词 / 导出符号 等最小充分证据。
 */
import { execFileSync } from 'node:child_process';
import {
  applyAdvisoryRisk,
  addChangedFiles,
  setPhase,
  upsertCheck,
} from './run.ts';
import {
  findExportSymbolChanges,
  findSensitiveKeywords,
} from './risk.ts';
import { matchesAny, normalizePath } from './paths.ts';
import type { CheckResult, RunState, SkegConfig } from './types.ts';

export type GitDiffSnapshot = {
  /** git 是否可用且在仓库内 */
  available: boolean;
  /** 变更文件列表 */
  files: string[];
  /** unified diff 文本（可能截断） */
  diff: string;
  error?: string;
};

export type ProveAnalysis = {
  checks: CheckResult[];
  files: string[];
  upgradeGuarded: boolean;
  upgradeReasons: string[];
};

export type ProveResult = {
  run: RunState;
  notes: string[];
};

type ExecGit = (cwd: string, args: string[]) => string;

/**
 * 读取工作区 diff 快照。
 * @param cwd 项目根
 * @param execGit 可注入的 git 执行器（测试用）
 * @returns diff 快照
 */
export function readGitDiff(
  cwd: string,
  execGit: ExecGit = defaultExecGit,
): GitDiffSnapshot {
  try {
    const filesRaw = execGit(cwd, [
      'diff',
      '--name-only',
      'HEAD',
    ]);
    // 含未暂存 + 已暂存；再补 untracked 太吵，v0.1 以 HEAD diff 为主，并合并 status
    const statusRaw = execGit(cwd, ['status', '--porcelain']);
    const fromDiff = filesRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normalizePath);
    const fromStatus: string[] = [];
    for (const line of statusRaw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // status format: XY PATH or XY ORIG -> PATH
      const pathPart = line.slice(3).split(' -> ').pop()?.trim();
      if (pathPart) fromStatus.push(normalizePath(pathPart));
    }
    const files = [...new Set([...fromDiff, ...fromStatus])];

    let diff = '';
    try {
      diff = execGit(cwd, ['diff', 'HEAD']);
      const staged = execGit(cwd, ['diff', '--cached']);
      if (staged.trim()) {
        diff = [diff, staged].filter((d) => d.trim()).join('\n');
      }
    } catch {
      diff = '';
    }

    // 控制注入/存储体积
    if (diff.length > 80_000) {
      diff = `${diff.slice(0, 80_000)}\n...[truncated]`;
    }

    return { available: true, files, diff };
  } catch (err) {
    return {
      available: false,
      files: [],
      diff: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 纯函数：根据 diff 快照生成 prove checks（便于单测）。
 * @param snapshot git diff 快照
 * @param run 当前 run
 * @param config 配置
 * @returns 分析结果
 */
export function analyzeProveSnapshot(
  snapshot: GitDiffSnapshot,
  run: RunState,
  config: SkegConfig,
): ProveAnalysis {
  const checks: CheckResult[] = [];
  const upgradeReasons: string[] = [];
  let upgradeGuarded = false;

  const tracked = [...new Set([...run.changedFiles, ...snapshot.files])];

  // --- diff check ---
  if (!snapshot.available) {
    checks.push({
      kind: 'diff',
      name: 'diff',
      passed: run.changedFiles.length > 0,
      evidence:
        run.changedFiles.length > 0
          ? `git unavailable; using tracked files: ${run.changedFiles.join(', ')}`
          : `git unavailable: ${snapshot.error ?? 'unknown'}`,
    });
  } else {
    const unexpectedProtected = tracked.filter((f) =>
      matchesAny(f, config.protectedPaths),
    );
    const passed = unexpectedProtected.length === 0;
    const evidenceParts = [
      tracked.length === 0 ? 'no file changes' : `${tracked.length} file(s): ${tracked.slice(0, 8).join(', ')}${tracked.length > 8 ? '…' : ''}`,
    ];
    if (unexpectedProtected.length > 0) {
      evidenceParts.push(`protected paths in diff: ${unexpectedProtected.join(', ')}`);
    }
    checks.push({
      kind: 'diff',
      name: 'diff',
      passed,
      evidence: evidenceParts.join('; '),
    });
  }

  // --- sensitive keywords（authPaths 未配置时的半确定性补充）---
  if (config.authPaths.length > 0) {
    checks.push({
      kind: 'diff',
      name: 'sensitive-keywords',
      passed: true,
      evidence: 'skipped (authPaths configured)',
    });
  } else {
    const keywords = findSensitiveKeywords(snapshot.diff);
    if (keywords.length > 0) {
      upgradeGuarded = true;
      upgradeReasons.push(`sensitive keywords: ${keywords.join(', ')}`);
      checks.push({
        kind: 'diff',
        name: 'sensitive-keywords',
        passed: false,
        evidence: `heuristic hit: ${keywords.join(', ')}. Configure authPaths for deterministic detection.`,
      });
    } else {
      checks.push({
        kind: 'diff',
        name: 'sensitive-keywords',
        passed: true,
        evidence: 'no sensitive keywords in diff',
      });
    }
  }

  // --- public API export 变化（apiPaths 未配置时的半确定性补充）---
  if (config.apiPaths.length > 0) {
    checks.push({
      kind: 'diff',
      name: 'public-api-export',
      passed: true,
      evidence: 'skipped (apiPaths configured)',
    });
  } else {
    const exports = findExportSymbolChanges(snapshot.diff);
    if (exports.length > 0) {
      upgradeGuarded = true;
      upgradeReasons.push(`export symbol changes: ${exports.length}`);
      checks.push({
        kind: 'diff',
        name: 'public-api-export',
        passed: false,
        evidence: `heuristic export changes (${exports.length}): ${exports.slice(0, 3).join(' | ')}`,
      });
    } else {
      checks.push({
        kind: 'diff',
        name: 'public-api-export',
        passed: true,
        evidence: 'no export symbol changes in diff',
      });
    }
  }

  return {
    checks,
    files: tracked,
    upgradeGuarded,
    upgradeReasons,
  };
}

/**
 * 当 phase 卡在 orient 或未记账 changedFiles 时，用 git 工作区变更自愈。
 * @param cwd 项目根
 * @param run 当前 run
 * @param execGit 可注入 git 执行器
 * @returns 可能推进 phase / 补记文件后的 run
 */
export function healChangedFilesFromGit(
  cwd: string,
  run: RunState,
  execGit: ExecGit = defaultExecGit,
): RunState {
  if (run.phase !== 'orient' && run.changedFiles.length > 0) return run;
  const snapshot = readGitDiff(cwd, execGit);
  if (snapshot.files.length === 0) return run;
  let next = addChangedFiles(run, snapshot.files);
  if (next.phase === 'orient') next = setPhase(next, 'change');
  return next;
}

/**
 * 对当前 run 执行 prove checks，写回 RunState。
 * @param cwd 项目根
 * @param run 当前 run
 * @param config 配置
 * @param execGit 可注入 git 执行器
 * @returns 更新后的 run 与备注
 */
export function runProveChecks(
  cwd: string,
  run: RunState,
  config: SkegConfig,
  execGit: ExecGit = defaultExecGit,
): ProveResult {
  const snapshot = readGitDiff(cwd, execGit);
  const analysis = analyzeProveSnapshot(snapshot, run, config);
  const notes = [...analysis.upgradeReasons];

  let next = run;
  if (analysis.files.length > 0) {
    next = addChangedFiles(next, analysis.files);
  }
  if (next.phase === 'orient' || next.phase === 'change') {
    next = setPhase(next, 'prove');
  }
  for (const check of analysis.checks) {
    next = upsertCheck(next, check);
  }
  if (analysis.upgradeGuarded) {
    next = applyAdvisoryRisk(next, 'guarded');
    notes.push('risk upgraded to guarded (advisory/heuristic)');
  }

  return { run: next, notes };
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
