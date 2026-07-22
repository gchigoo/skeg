/**
 * 确定性风险检测：tool_call hook 的权威兜底层。
 */
import {
  extractPathsFromCommand,
  matchesAny,
  normalizePath,
  pathMatchCandidates,
} from './paths.ts';
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
 * 判断是否为 Skeg 控制面路径（硬编码，不可配置关闭）。
 * @param path 归一化路径
 * @returns 是否控制面
 */
export function isControlPlanePath(path: string): boolean {
  const candidates = pathMatchCandidates(normalizePath(path));
  return candidates.some(
    (p) =>
      p === '.skeg/config.json' ||
      p === '.skeg/providers' ||
      p.startsWith('.skeg/providers/'),
  );
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

  if (isControlPlanePath(normalized)) {
    hits.push({
      trigger: 'controlPlane',
      strength: 'deterministic',
      path: normalized,
      reason: `Skeg control-plane path requires confirm: ${normalized}`,
    });
  }

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
 * 归一化命令后取短指纹（压缩空白、统一换行）。
 * @param command 原始命令
 * @returns 8 位 hex 指纹
 */
export function commandFingerprint(command: string): string {
  const normalized = command.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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
        fingerprint: commandFingerprint(command),
        reason: `Dangerous command matched ${pattern}: ${command.slice(0, 120)}`,
      };
    }
  }
  return null;
}

/**
 * 构造 gate acknowledgement key。
 * 危险命令用 fingerprint，避免空 path 导致一次确认放行全部危险命令。
 * @param hit 风险命中
 * @returns acknowledgement key
 */
export function gateAcknowledgementKey(hit: RiskHit): string {
  if (hit.trigger === 'dangerousCommand') {
    const fp = hit.fingerprint || commandFingerprint(hit.reason);
    return `${hit.trigger}:${fp}`;
  }
  return `${hit.trigger}:${hit.path || ''}`;
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
 * 读取 config.policies[trigger].action：confirm/block → true；observe/ignore → false。
 * @param trigger trigger id
 * @param config 可选配置；缺省时全部 confirm
 * @returns 是否需要 gate
 */
export function requiresGate(
  trigger: TriggerId,
  config?: SkegConfig,
): boolean {
  // 控制面恒 confirm，无视项目 policies
  if (trigger === 'controlPlane') return true;
  const action = config?.policies?.[trigger]?.action;
  if (!action) return true;
  return action === 'confirm' || action === 'block';
}

/**
 * 判断命中是否应硬性拦截（block，无确认放行）。
 * @param trigger trigger id
 * @param config 配置
 * @returns 是否 block
 */
export function requiresBlock(
  trigger: TriggerId,
  config?: SkegConfig,
): boolean {
  // 控制面只 confirm，不硬 block（允许用户显式放行）
  if (trigger === 'controlPlane') return false;
  return config?.policies?.[trigger]?.action === 'block';
}

/**
 * 构造多 hit gate 的 action fingerprint。
 * @param hits 命中列表
 * @param toolName 工具名
 * @param input 工具参数
 * @returns fingerprint
 */
export function actionFingerprint(
  hits: RiskHit[],
  toolName: string,
  input: Record<string, unknown>,
): string {
  const parts = hits.map((hit) => {
    if (hit.trigger === 'dangerousCommand') {
      return `${hit.trigger}:${hit.fingerprint || commandFingerprint(String(input.command ?? hit.reason))}`;
    }
    if (hit.path) return `${hit.trigger}:${normalizePath(hit.path)}`;
    return `${hit.trigger}:${toolName}`;
  });
  return parts.sort().join('|');
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
