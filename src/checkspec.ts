/**
 * CheckSpec：可配置的验证检查定义。
 */
import type { RiskLevel, SkegConfig } from './types.ts';

export type CheckSpec = {
  id: string;
  /** 子串或 /regex/ 形式 */
  match: string;
  /** 适用风险级别；缺省两端都适用 */
  risk?: RiskLevel | 'both';
};

/**
 * 从 config 解析 CheckSpec 列表。
 * @param config 配置
 * @returns specs
 */
export function listCheckSpecs(config: SkegConfig): CheckSpec[] {
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
  config: SkegConfig,
  risk: RiskLevel,
): string[] {
  return risk === 'guarded' ? config.checks.guarded : config.checks.default;
}

/**
 * 为 package script 名生成锚定正则（避免 `echo test` 等假阳性）。
 * @param script package.json script 名
 * @returns /regex/i 形式
 */
function packageScriptMatcher(script: string): string {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `/^(npm|pnpm|yarn|bun)\\s+(run\\s+)?${escaped}(?:\\s|$)/i`;
}

/**
 * 从 package.json scripts 探测常用命令匹配。
 * @param scripts package.json scripts
 * @returns checks.commands 片段（锚定正则）
 */
export function detectCommandsFromScripts(
  scripts: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (scripts.test) out.test = packageScriptMatcher('test');
  if (scripts.typecheck) {
    out.typecheck = packageScriptMatcher('typecheck');
  } else if (scripts['type-check']) {
    out.typecheck = packageScriptMatcher('type-check');
  }
  if (scripts.lint) out.lint = packageScriptMatcher('lint');
  if (scripts.build) out.build = packageScriptMatcher('build');
  return out;
}
