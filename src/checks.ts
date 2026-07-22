/**
 * command check 自动记账：从 bash 验证命令结果写入 RunState.checks。
 */
import { matchCheckPattern } from './checkspec.ts';
import type {
  CheckMatcher,
  CheckRun,
  EvidenceSource,
  SkegConfig,
} from './types.ts';

export type ClassifiedCheck = {
  kind: 'command';
  name: string;
  source?: EvidenceSource;
};

const EVIDENCE_MAX = 400;

/** node 带可选 flag 后接 --test（含 --experimental-strip-types） */
const NODE_TEST_RUNNER = String.raw`node(?:\s+--[A-Za-z0-9_=.-]+)*\s+--test`;

/** 裸跑 test 命令（无文件/模式参数时归为 test） */
const BARE_TEST_RE = new RegExp(
  String.raw`(?:^|[;&|]\s*)(?:npm\s+test|npm\s+run\s+test(?:s)?|pnpm\s+test|pnpm\s+run\s+test(?:s)?|yarn\s+test|bun\s+test|${NODE_TEST_RUNNER}|vitest(?:\s+run)?|jest|pytest|go\s+test|cargo\s+test|deno\s+test)(?:\s|$)`,
  'i',
);

/** 带文件/路径参数的 targeted test */
const TARGETED_TEST_RE = new RegExp(
  String.raw`(?:npm\s+test|npm\s+run\s+test(?:s)?|pnpm\s+test|pnpm\s+run\s+test(?:s)?|yarn\s+test|bun\s+test|${NODE_TEST_RUNNER}|vitest(?:\s+run)?|jest|pytest|go\s+test|cargo\s+test|deno\s+test)\s+\S+`,
  'i',
);

const LINT_RE =
  /(?:^|[;&|]\s*)(?:npm\s+run\s+lint|pnpm\s+lint|pnpm\s+run\s+lint|yarn\s+lint|eslint|ruff\s+check|biome\s+lint|golangci-lint)(?:\s|$)/i;

const TYPECHECK_RE =
  /(?:^|[;&|]\s*)(?:npm\s+run\s+typecheck|pnpm\s+typecheck|pnpm\s+run\s+typecheck|yarn\s+typecheck|tsc\b|vue-tsc\b|pyright\b|mypy\b)/i;

const BUILD_RE =
  /(?:^|[;&|]\s*)(?:npm\s+run\s+build|pnpm\s+build|pnpm\s+run\s+build|yarn\s+build|vite\s+build|next\s+build|cargo\s+build|go\s+build)(?:\s|$)/i;

/**
 * 判断命令是否带有文件/模式参数（用于 targeted-test）。
 * @param command bash 命令
 * @returns 是否 targeted
 */
function looksTargeted(command: string): boolean {
  const trimmed = command.trim();
  // 常见：vitest path、jest path、pytest path、go test ./pkg、pnpm test src/foo
  if (TARGETED_TEST_RE.test(trimmed)) {
    // 排除仅带 flag 的裸跑：vitest --run、jest --coverage、npm test -- --watch=false
    const afterRunner = trimmed
      .replace(
        new RegExp(
          String.raw`^(?:npm\s+(?:run\s+)?test(?:s)?|pnpm\s+(?:run\s+)?test(?:s)?|yarn\s+test|bun\s+test|${NODE_TEST_RUNNER}|vitest(?:\s+run)?|jest|pytest|go\s+test|cargo\s+test|deno\s+test)\s*`,
          'i',
        ),
        '',
      )
      .trim();
    if (!afterRunner) return false;
    // 仅 flags（以 - 开头的 token）不算 targeted
    const tokens = afterRunner.split(/\s+/);
    const hasPathLike = tokens.some(
      (t) =>
        !t.startsWith('-') &&
        (t.includes('/') ||
          t.includes('\\') ||
          t.includes('*') ||
          t.includes('.') ||
          /^[A-Za-z0-9_-]+\.(ts|tsx|js|jsx|py|go|rs)$/i.test(t)),
    );
    return hasPathLike;
  }
  return false;
}

/**
 * 用配置 commands 映射匹配命令（字符串或结构化 CheckMatcher）。
 * @param command bash 命令
 * @param commands check 名 → 匹配定义
 * @returns 命中的 check 名，或 null
 */
function matchConfiguredCommands(
  command: string,
  commands: Record<string, string | CheckMatcher> | undefined,
): string | null {
  if (!commands) return null;
  for (const [name, pattern] of Object.entries(commands)) {
    if (!pattern) continue;
    if (matchCheckPattern(command, pattern)) return name;
  }
  return null;
}

/**
 * 将 bash 命令分类为 command check，非验证命令返回 null。
 * 优先级：targeted-test → 配置 matcher → bare test → typecheck / lint / build。
 * @param command bash 命令
 * @param config 项目配置
 * @returns 分类结果或 null
 */
export function classifyCheckCommand(
  command: string,
  config: SkegConfig,
): ClassifiedCheck | null {
  const cmd = command.trim();
  if (!cmd) return null;

  // targeted-test 必须先于配置匹配，避免 /init 探测的 "test" 降级路径参数命令
  if (looksTargeted(cmd)) {
    return { kind: 'command', name: 'targeted-test' };
  }

  const configured = matchConfiguredCommands(cmd, config.checks.commands);
  if (configured) {
    return { kind: 'command', name: configured };
  }

  if (BARE_TEST_RE.test(cmd)) {
    return { kind: 'command', name: 'test' };
  }

  if (TYPECHECK_RE.test(cmd)) {
    return { kind: 'command', name: 'typecheck' };
  }

  if (LINT_RE.test(cmd)) {
    return { kind: 'command', name: 'lint' };
  }

  if (BUILD_RE.test(cmd)) {
    return { kind: 'command', name: 'build' };
  }

  return null;
}

/**
 * 从 bash 工具结果构建 CheckRun（revision/id 由 reducer 补齐）。
 * @param name check 名
 * @param command 原命令
 * @param passed 是否成功
 * @param output 工具输出（可空）
 * @param source 分类来源
 * @returns CheckRun 草稿
 */
export function buildCommandCheck(
  name: string,
  command: string,
  passed: boolean,
  output?: string,
  source?: EvidenceSource,
): Omit<CheckRun, 'id' | 'revision' | 'observedAt'> &
  Partial<Pick<CheckRun, 'id' | 'revision' | 'observedAt'>> {
  const tail = (output ?? '').trim().slice(-EVIDENCE_MAX);
  const evidence = tail
    ? `${command} → ${passed ? 'ok' : 'fail'}: ${tail}`
    : `${command} → ${passed ? 'ok' : 'fail'}`;
  return {
    kind: 'command',
    name,
    passed,
    command,
    exitCode: passed ? 0 : 1,
    source,
    evidence: evidence.length > EVIDENCE_MAX + 80
      ? `${evidence.slice(0, EVIDENCE_MAX + 80)}…`
      : evidence,
  };
}
