/**
 * CheckSpec：可配置的验证检查定义与结构化 matcher。
 */
import type { CheckMatcher, RiskLevel, VeritackConfig } from './types.ts';

export type CheckSpec = {
  id: string;
  /** 字符串仅允许 /regex/；或结构化 CheckMatcher */
  match: string | CheckMatcher;
  /** 适用风险级别；缺省两端都适用 */
  risk?: RiskLevel | 'both';
};

/**
 * 从 config 解析 CheckSpec 列表。
 * @param config 配置
 * @returns specs
 */
export function listCheckSpecs(config: VeritackConfig): CheckSpec[] {
  const commands = config.checks.commands ?? {};
  return Object.entries(commands).map(([id, match]) => ({
    id,
    match,
    risk: 'both',
  }));
}

/**
 * 按 risk 过滤当前需要的 check 名。
 * @param config 配置
 * @param risk 当前 risk
 * @returns check 名列表
 */
export function requiredCheckNames(
  config: VeritackConfig,
  risk: RiskLevel,
): string[] {
  return risk === 'guarded' ? config.checks.guarded : config.checks.default;
}

/**
 * 判断值是否为结构化 CheckMatcher。
 * @param value 候选
 * @returns 是否 matcher
 */
export function isCheckMatcher(value: unknown): value is CheckMatcher {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'package-script' && typeof v.script === 'string') return true;
  if (
    v.kind === 'argv' &&
    typeof v.executable === 'string' &&
    Array.isArray(v.args) &&
    v.args.every((a) => typeof a === 'string')
  ) {
    return true;
  }
  if (v.kind === 'regex' && typeof v.pattern === 'string') return true;
  return false;
}

/**
 * 校验正则 flags / 长度；非法则不可匹配。
 * @param body 正则体
 * @param flags flags
 * @returns 是否合法
 */
function isSafeRegex(body: string, flags: string): boolean {
  if (!body || body.length > 200) return false;
  if (flags && !/^[imsu]*$/.test(flags)) return false;
  return true;
}

/**
 * 测试命令是否匹配单个 CheckMatcher / 字符串模式。
 * @param command bash 命令
 * @param match 匹配定义
 * @returns 是否命中
 */
export function matchCheckPattern(
  command: string,
  match: string | CheckMatcher,
): boolean {
  if (typeof match === 'string') {
    if (!match) return false;
    // v0.7+：普通子串 matcher 已拒绝；仅 /regex/ 字符串生效
    if (!(match.startsWith('/') && match.lastIndexOf('/') > 0)) return false;
    const last = match.lastIndexOf('/');
    const body = match.slice(1, last);
    const flags = match.slice(last + 1);
    if (!isSafeRegex(body, flags)) return false;
    try {
      return new RegExp(body, flags).test(command);
    } catch {
      return false;
    }
  }

  if (match.kind === 'package-script') {
    const escaped = match.script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      String.raw`^(npm|pnpm|yarn|bun)\s+(run\s+)?${escaped}(?:\s|$)`,
      'i',
    ).test(command.trim());
  }

  if (match.kind === 'regex') {
    const pattern = match.pattern;
    if (!pattern || pattern.length > 200) return false;
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const last = pattern.lastIndexOf('/');
      const body = pattern.slice(1, last);
      const flags = pattern.slice(last + 1);
      if (!isSafeRegex(body, flags)) return false;
      try {
        return new RegExp(body, flags).test(command);
      } catch {
        return false;
      }
    }
    try {
      return new RegExp(pattern, 'i').test(command);
    } catch {
      return false;
    }
  }

  if (match.kind === 'argv') {
    const tokens = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const normalized = tokens.map((t) => t.replace(/^['"]|['"]$/g, ''));
    if (normalized.length === 0) return false;
    if (normalized[0] !== match.executable) return false;
    // 要求 match.args 按序出现在 executable 之后
    let idx = 1;
    for (const arg of match.args) {
      const found = normalized.indexOf(arg, idx);
      if (found === -1) return false;
      idx = found + 1;
    }
    return true;
  }

  return false;
}

/**
 * 从 package.json scripts 探测常用命令匹配。
 * @param scripts package.json scripts
 * @returns checks.commands 片段（结构化 package-script）
 */
export function detectCommandsFromScripts(
  scripts: Record<string, string>,
): Record<string, CheckMatcher> {
  const out: Record<string, CheckMatcher> = {};
  if (scripts.test) out.test = { kind: 'package-script', script: 'test' };
  if (scripts.typecheck) {
    out.typecheck = { kind: 'package-script', script: 'typecheck' };
  } else if (scripts['type-check']) {
    out.typecheck = { kind: 'package-script', script: 'type-check' };
  }
  if (scripts.lint) out.lint = { kind: 'package-script', script: 'lint' };
  if (scripts.build) out.build = { kind: 'package-script', script: 'build' };
  return out;
}
