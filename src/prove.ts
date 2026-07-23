/**
 * Prove 阶段：收集 diff / signals；敏感关键词与 export 变化为 RiskSignal。
 */
import { execFileSync } from 'node:child_process';
import {
  reconcileAgainstBaseline,
  type ExecGit,
} from './baseline.ts';
import { reduce } from './reducer.ts';
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
import type {
  CheckRun,
  RiskSignal,
  RunState,
  VeritackConfig,
  WorkspaceBaseline,
} from './types.ts';
import { EMPTY_BASELINE } from './types.ts';

export type GitDiffSnapshot = {
  /** git 是否可用且在仓库内 */
  available: boolean;
  /** 变更文件列表（相对 baseline.head 或 HEAD） */
  files: string[];
  /** unified diff 文本（可能截断） */
  diff: string;
  error?: string;
};

export type ProveAnalysis = {
  checks: Array<
    Omit<CheckRun, 'id' | 'revision' | 'observedAt'> &
      Partial<Pick<CheckRun, 'id' | 'revision' | 'observedAt'>>
  >;
  signals: Array<
    Omit<RiskSignal, 'id' | 'revision'> & Partial<Pick<RiskSignal, 'id' | 'revision'>>
  >;
  files: string[];
  upgradeGuarded: boolean;
  upgradeReasons: string[];
};

export type ProveResult = {
  run: RunState;
  notes: string[];
};

/**
 * 读取工作区 diff 快照。
 * 有 baseline.head 时以之为基准，避免 run 中途 commit 丢证据。
 * @param cwd 项目根
 * @param baseline 可选 baseline
 * @param execGit 可注入的 git 执行器
 * @returns diff 快照
 */
export function readGitDiff(
  cwd: string,
  baseline?: WorkspaceBaseline,
  execGit: ExecGit = defaultExecGit,
): GitDiffSnapshot {
  const base = baseline?.head && baseline.head.length > 0 ? baseline.head : 'HEAD';
  try {
    const filesRaw = execGit(cwd, ['diff', '--name-only', base]);
    const statusRaw = execGit(cwd, ['status', '--porcelain']);
    const fromDiff = filesRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normalizePath);
    const fromStatus: string[] = [];
    for (const line of statusRaw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const pathPart = line.slice(3).split(' -> ').pop()?.trim();
      if (pathPart) fromStatus.push(normalizePath(pathPart));
    }
    const files = [...new Set([...fromDiff, ...fromStatus])];

    let diff = '';
    try {
      diff = execGit(cwd, ['diff', base]);
      const staged = execGit(cwd, ['diff', '--cached']);
      if (staged.trim()) {
        diff = [diff, staged].filter((d) => d.trim()).join('\n');
      }
    } catch {
      diff = '';
    }

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
 * 纯函数：根据 diff 快照生成 prove checks + signals。
 * @param snapshot git diff 快照
 * @param run 当前 run
 * @param config 配置
 * @returns 分析结果
 */
export function analyzeProveSnapshot(
  snapshot: GitDiffSnapshot,
  run: RunState,
  config: VeritackConfig,
): ProveAnalysis {
  const checks: ProveAnalysis['checks'] = [];
  const signals: ProveAnalysis['signals'] = [];
  const upgradeReasons: string[] = [];
  let upgradeGuarded = false;

  // 证明范围：本 run 文件；排除 pre-existing
  const pre = new Set(run.preExistingFiles ?? []);
  const tracked = [...new Set([...run.changedFiles, ...snapshot.files])].filter(
    (f) => !pre.has(f),
  );

  if (!snapshot.available) {
    // fail-closed：tracked path 不能证明当前 diff；逃生用 /finish --waive
    checks.push({
      kind: 'diff',
      name: 'diff',
      passed: false,
      evidence: `git unavailable: ${snapshot.error ?? 'unknown'}`,
    });
  } else {
    const unexpectedProtected = tracked.filter((f) =>
      matchesAny(f, config.protectedPaths),
    );
    const passed = unexpectedProtected.length === 0;
    const evidenceParts = [
      tracked.length === 0
        ? 'no file changes'
        : `${tracked.length} file(s): ${tracked.slice(0, 8).join(', ')}${tracked.length > 8 ? '…' : ''}`,
    ];
    if (unexpectedProtected.length > 0) {
      evidenceParts.push(
        `protected paths in diff: ${unexpectedProtected.join(', ')}`,
      );
    }
    checks.push({
      kind: 'diff',
      name: 'diff',
      passed,
      evidence: evidenceParts.join('; '),
    });
  }

  // signal 只扫本 run 文件片段，排除 pre-existing（避免启动前脏文件假警报）
  const scopedDiff = scopeDiffToFiles(snapshot.diff, tracked);

  // sensitive keywords → RiskSignal（非 failed check）
  if (config.authPaths.length === 0) {
    const keywords = findSensitiveKeywords(scopedDiff);
    if (keywords.length > 0) {
      upgradeGuarded = true;
      upgradeReasons.push(`sensitive keywords: ${keywords.join(', ')}`);
      signals.push({
        trigger: 'sensitive-keywords',
        strength: 'semi',
        evidence: `heuristic hit: ${keywords.join(', ')}. Configure authPaths for deterministic detection.`,
        requiredChecks: ['targeted-test'],
      });
    }
  }

  // public API export → RiskSignal
  if (config.apiPaths.length === 0) {
    const exports = findExportSymbolChanges(scopedDiff);
    if (exports.length > 0) {
      upgradeGuarded = true;
      upgradeReasons.push(`export symbol changes: ${exports.length}`);
      signals.push({
        trigger: 'public-api-export',
        strength: 'semi',
        evidence: `heuristic export changes (${exports.length}): ${exports.slice(0, 3).join(' | ')}`,
        requiredChecks: ['diff'],
      });
    }
  }

  return {
    checks,
    signals,
    files: tracked,
    upgradeGuarded,
    upgradeReasons,
  };
}

/**
 * 当 phase 卡在 orient 或未记账 changedFiles 时，用 baseline reconcile 自愈。
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

  const baseline = run.baseline?.capturedAt
    ? run.baseline
    : EMPTY_BASELINE;

  if (baseline.capturedAt) {
    const reconciled = reconcileAgainstBaseline(cwd, baseline, execGit);
    if (reconciled.runChanges.length === 0 && !reconciled.headMoved) return run;
    return reduce(run, {
      type: 'WORKSPACE_RECONCILED',
      changedFiles: reconciled.runChanges,
      preExistingFiles: reconciled.preExisting,
      headMoved: reconciled.headMoved,
    });
  }

  const snapshot = readGitDiff(cwd, undefined, execGit);
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
  config: VeritackConfig,
  execGit: ExecGit = defaultExecGit,
): ProveResult {
  const snapshot = readGitDiff(cwd, run.baseline, execGit);
  const analysis = analyzeProveSnapshot(snapshot, run, config);
  const notes = [...analysis.upgradeReasons];

  let next = run;
  if (analysis.files.length > 0) {
    // 证明阶段补记文件：用 WORKSPACE_RECONCILED 避免多余 revision bump 当文件已在列表中
    const trulyNew = analysis.files.filter((f) => !next.changedFiles.includes(f));
    if (trulyNew.length > 0) {
      next = reduce(next, {
        type: 'WORKSPACE_RECONCILED',
        changedFiles: trulyNew,
        preExistingFiles: next.preExistingFiles,
      });
    }
  }
  if (next.phase === 'orient' || next.phase === 'change') {
    next = setPhase(next, 'prove');
  }
  for (const check of analysis.checks) {
    next = upsertCheck(next, check);
  }
  for (const signal of analysis.signals) {
    next = reduce(next, { type: 'SIGNAL_RAISED', signal });
  }
  if (analysis.upgradeGuarded) {
    next = applyAdvisoryRisk(next, 'guarded');
    notes.push('risk upgraded to guarded (advisory/heuristic)');
  }

  return { run: next, notes };
}

/**
 * 按 `diff --git` 头切分 unified diff，只保留指定文件的片段。
 * 启动前 dirty 后又被本 run 修改的文件仍保留全片段（无法减去 baseline patch）。
 * @param diff 完整 diff 文本
 * @param files 允许扫描的相对路径
 * @returns 拼接后的 scoped diff
 */
export function scopeDiffToFiles(diff: string, files: string[]): string {
  if (!diff.trim() || files.length === 0) return '';
  const allow = new Set(files.map(normalizePath));
  const chunks: string[] = [];
  let currentFile: string | null = null;
  let current: string[] = [];

  const flush = () => {
    if (currentFile && allow.has(currentFile) && current.length > 0) {
      chunks.push(current.join('\n'));
    }
    current = [];
    currentFile = null;
  };

  for (const line of diff.split(/\r?\n/)) {
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      flush();
      currentFile = normalizePath(gitHeader[2] || gitHeader[1]);
      current = [line];
      continue;
    }
    const plusHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusHeader && !currentFile) {
      currentFile = normalizePath(plusHeader[1]);
    }
    if (currentFile) current.push(line);
  }
  flush();
  return chunks.join('\n');
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
