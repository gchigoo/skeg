/**
 * 确定性风险检测：tool_call hook 的权威兜底层。
 */
import { extractPathsFromCommand, matchesAny, normalizePath } from './paths.ts';
import type { RiskHit, SkegConfig, TriggerId } from './types.ts';

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*\b777\b/i,
  /\bgit\s+push\b.*--force\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
];

const WRITE_TOOLS = new Set(['write', 'edit', 'Bash', 'bash']);

/**
 * 从工具调用中提取涉及的文件路径。
 * @param toolName 工具名
 * @param input 工具参数
 * @returns 路径列表
 */
export function pathsFromToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const name = toolName.toLowerCase();
  if (name === 'write' || name === 'edit' || name === 'read') {
    const path = input.path ?? input.file_path ?? input.filePath;
    return typeof path === 'string' ? [normalizePath(path)] : [];
  }
  if (name === 'bash') {
    const command = input.command;
    return typeof command === 'string' ? extractPathsFromCommand(command) : [];
  }
  return [];
}

/**
 * 检测单条路径命中的风险 trigger。
 * @param path 文件路径
 * @param config 项目配置
 * @returns 命中列表
 */
export function detectPathRisks(path: string, config: SkegConfig): RiskHit[] {
  const hits: RiskHit[] = [];
  const normalized = normalizePath(path);

  if (matchesAny(normalized, config.protectedPaths)) {
    hits.push({
      trigger: 'protectedPaths',
      strength: 'deterministic',
      path: normalized,
      reason: `Protected path: ${normalized}`,
    });
  }

  if (matchesAny(normalized, config.migrationPaths)) {
    hits.push({
      trigger: 'databaseMigration',
      strength: 'deterministic',
      path: normalized,
      reason: `Database migration path: ${normalized}`,
    });
  }

  if (matchesAny(normalized, config.dependencyFiles)) {
    hits.push({
      trigger: 'dependencyChange',
      strength: 'deterministic',
      path: normalized,
      reason: `Dependency manifest change: ${normalized}`,
    });
  }

  if (config.apiPaths.length > 0 && matchesAny(normalized, config.apiPaths)) {
    hits.push({
      trigger: 'publicApiChange',
      strength: 'deterministic',
      path: normalized,
      reason: `Public API path (configured): ${normalized}`,
    });
  }

  if (config.authPaths.length > 0 && matchesAny(normalized, config.authPaths)) {
    hits.push({
      trigger: 'authChange',
      strength: 'deterministic',
      path: normalized,
      reason: `Auth path (configured): ${normalized}`,
    });
  }

  return hits;
}

/**
 * 检测危险 bash 命令。
 * @param command bash 命令
 * @returns 命中或 null
 */
export function detectDangerousCommand(command: string): RiskHit | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        trigger: 'dangerousCommand',
        strength: 'deterministic',
        path: '',
        reason: `Dangerous command matched ${pattern}: ${command.slice(0, 120)}`,
      };
    }
  }
  return null;
}

/**
 * 对一次 tool_call 做完整风险扫描。
 * @param toolName 工具名
 * @param input 工具参数
 * @param config 项目配置
 * @returns 命中列表（按强度排序，确定性优先）
 */
export function scanToolCall(
  toolName: string,
  input: Record<string, unknown>,
  config: SkegConfig,
): RiskHit[] {
  const hits: RiskHit[] = [];
  const name = toolName.toLowerCase();

  if (name === 'bash' && typeof input.command === 'string') {
    const danger = detectDangerousCommand(input.command);
    if (danger) hits.push(danger);
  }

  // 只对写操作做路径风险；read 不升级
  if (name === 'read') return hits;

  if (!WRITE_TOOLS.has(toolName) && name !== 'write' && name !== 'edit' && name !== 'bash') {
    return hits;
  }

  for (const path of pathsFromToolCall(toolName, input)) {
    hits.push(...detectPathRisks(path, config));
  }

  return dedupeHits(hits);
}

/**
 * 判断命中是否需要拦截确认（gate）。
 * @param trigger trigger id
 * @returns 是否需要 gate
 */
export function requiresGate(trigger: TriggerId): boolean {
  return (
    trigger === 'protectedPaths' ||
    trigger === 'dangerousCommand' ||
    trigger === 'databaseMigration' ||
    trigger === 'dependencyChange' ||
    trigger === 'publicApiChange' ||
    trigger === 'authChange'
  );
}

const SENSITIVE_KEYWORD_RE =
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|session|permission|authorize|authz|rbac|role)\b/gi;

/**
 * Prove 阶段敏感关键词扫描（authChange 未配置时的半确定性补充）。
 * @param text diff 或文件内容
 * @returns 是否命中敏感关键词
 */
export function scanSensitiveKeywords(text: string): boolean {
  return findSensitiveKeywords(text).length > 0;
}

/**
 * 提取命中的敏感关键词（去重、小写）。
 * @param text diff 或文件内容
 * @returns 关键词列表
 */
export function findSensitiveKeywords(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SENSITIVE_KEYWORD_RE)) {
    found.add(match[0].toLowerCase());
  }
  return [...found];
}

/**
 * 从 unified diff 中提取新增/删除的 export 符号行。
 * @param diffText git diff 文本
 * @returns 变更的 export 行（去重）
 */
export function findExportSymbolChanges(diffText: string): string[] {
  const lines = diffText.split(/\r?\n/);
  const changes: string[] = [];
  for (const line of lines) {
    if (!(line.startsWith('+') || line.startsWith('-'))) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const body = line.slice(1);
    if (/^\s*export\s+/.test(body)) {
      changes.push(line.slice(0, 120));
    }
  }
  return [...new Set(changes)];
}

/**
 * 去重：同 trigger + path 只保留一条。
 * @param hits 原始命中
 * @returns 去重后列表
 */
function dedupeHits(hits: RiskHit[]): RiskHit[] {
  const seen = new Set<string>();
  const out: RiskHit[] = [];
  for (const hit of hits) {
    const key = `${hit.trigger}:${hit.path}:${hit.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
