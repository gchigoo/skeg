/**
 * command check 自动记账：从 bash 验证命令结果写入 RunState.checks。
 */
import type { CheckResult, SkegConfig } from './types.ts';

export type ClassifiedCheck = {
  kind: 'command';
  name: string;
};

const EVIDENCE_MAX = 400;

/** 裸跑 test 命令（无文件/模式参数时归为 test） */
const BARE_TEST_RE =
  /(?:^|[;&|]\s*)(?:npm\s+test|npm\s+run\s+test(?:s)?|pnpm\s+test|pnpm\s+run\s+test(?:s)?|yarn\s+test|bun\s+test|vitest(?:\s+run)?|jest|pytest|go\s+test|cargo\s+test|deno\s+test)(?:\s|$)/i;

/** 带文件/路径参数的 targeted test */
const TARGETED_TEST_RE =
  /(?:npm\s+test|npm\s+run\s+test(?:s)?|pnpm\s+test|pnpm\s+run\s+test(?:s)?|yarn\s+test|bun\s+test|vitest(?:\s+run)?|jest|pytest|go\s+test|cargo\s+test|deno\s+test)\s+\S+/i;

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
        /^(?:npm\s+(?:run\s+)?test(?:s)?|pnpm\s+(?:run\s+)?test(?:s)?|yarn\s+test|bun\s+test|vitest(?:\s+run)?|jest|pytest|go\s+test|cargo\s+test|deno\s+test)\s*/i,
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
 * 用配置 commands 映射匹配命令。
 * @param command bash 命令
 * @param commands check 名 → 子串或 /regex/
 * @returns 命中的 check 名，或 null
 */
function matchConfiguredCommands(
  command: string,
  commands: Record<string, string> | undefined,
): string | null {
  if (!commands) return null;
  for (const [name, pattern] of Object.entries(commands)) {
    if (!pattern) continue;
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const last = pattern.lastIndexOf('/');
      const body = pattern.slice(1, last);
      const flags = pattern.slice(last + 1);
      try {
        if (new RegExp(body, flags).test(command)) return name;
      } catch {
        // 非法正则忽略，继续
      }
    } else if (command.includes(pattern)) {
      return name;
    }
  }
  return null;
}

/**
 * 将 bash 命令分类为 command check，非验证命令返回 null。
 * @param command bash 命令
 * @param config 项目配置（commands 覆盖优先）
 * @returns 分类结果或 null
 */
export function classifyCheckCommand(
  command: string,
  config: SkegConfig,
): ClassifiedCheck | null {
  const cmd = command.trim();
  if (!cmd) return null;

  const configured = matchConfiguredCommands(cmd, config.checks.commands);
  if (configured) {
    return { kind: 'command', name: configured };
  }

  if (looksTargeted(cmd)) {
    return { kind: 'command', name: 'targeted-test' };
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
 * 从 bash 工具结果构建 CheckResult。
 * @param name check 名
 * @param command 原命令
 * @param passed 是否成功
 * @param output 工具输出（可空）
 * @returns CheckResult
 */
export function buildCommandCheck(
  name: string,
  command: string,
  passed: boolean,
  output?: string,
): CheckResult {
  const tail = (output ?? '').trim().slice(-EVIDENCE_MAX);
  const evidence = tail
    ? `${command} → ${passed ? 'ok' : 'fail'}: ${tail}`
    : `${command} → ${passed ? 'ok' : 'fail'}`;
  return {
    kind: 'command',
    name,
    passed,
    evidence: evidence.length > EVIDENCE_MAX + 80
      ? `${evidence.slice(0, EVIDENCE_MAX + 80)}…`
      : evidence,
  };
}
