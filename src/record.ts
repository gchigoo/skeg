/**
 * Record：将值得长期保留的知识惰性写入 `.skeg/records/`。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SKEG_DIR, type RunState } from './types.ts';

export type RecordType = 'decision' | 'migration' | 'incident';

export const RECORD_TYPES: RecordType[] = ['decision', 'migration', 'incident'];

const PREFIX: Record<RecordType, string> = {
  decision: 'DEC',
  migration: 'MIG',
  incident: 'INC',
};

export type SkegRecord = {
  id: string;
  type: RecordType;
  title: string;
  body: string;
  runId?: string;
  createdAt: string;
  fileName: string;
  relativePath: string;
};

export type CreateRecordInput = {
  type: RecordType;
  title: string;
  body?: string;
  run?: RunState | null;
};

/**
 * 解析 `/record` 参数。
 * 支持：`decision Title`、`--type migration Title`、`incident Title | body`
 * @param args 命令参数
 * @returns 解析结果或错误信息
 */
export function parseRecordArgs(args: string):
  | { ok: true; type: RecordType; title: string; body: string }
  | { ok: false; error: string } {
  const raw = (args || '').trim();
  if (!raw) {
    return {
      ok: false,
      error: 'Usage: /record <decision|migration|incident> <title> [| body]',
    };
  }

  let rest = raw;
  let type: RecordType | undefined;

  const typeFlag = rest.match(/^--type\s+(\S+)\s+(.*)$/is);
  if (typeFlag) {
    type = normalizeType(typeFlag[1]);
    rest = typeFlag[2].trim();
  } else {
    const parts = rest.split(/\s+/);
    type = normalizeType(parts[0]);
    if (type) rest = parts.slice(1).join(' ').trim();
  }

  if (!type) {
    return {
      ok: false,
      error: 'Type must be one of: decision, migration, incident',
    };
  }

  if (!rest) {
    return { ok: false, error: 'Title is required.' };
  }

  const split = rest.split(/\s*\|\s*/);
  const title = (split[0] || '').trim();
  const body = split.slice(1).join(' | ').trim();
  if (!title) {
    return { ok: false, error: 'Title is required.' };
  }

  return { ok: true, type, title, body };
}

/** listRecords 返回的精简条目（供注入索引用）。 */
export type RecordIndexEntry = {
  id: string;
  type: RecordType;
  title: string;
  createdAt: string;
  fileName: string;
};

/**
 * 列出 `.skeg/records/` 中的记录，按 createdAt 倒序。
 * @param cwd 项目根
 * @param limit 最多返回条数（默认 5）
 * @returns 索引条目；目录不存在或为空时返回 []
 */
export function listRecords(cwd: string, limit = 5): RecordIndexEntry[] {
  const dir = join(cwd, SKEG_DIR, 'records');
  if (!existsSync(dir)) return [];

  const entries: RecordIndexEntry[] = [];
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith('.md')) continue;
    const parsed = parseRecordFrontmatter(
      readFileSync(join(dir, fileName), 'utf8'),
    );
    if (!parsed) continue;
    entries.push({
      id: parsed.id,
      type: parsed.type,
      title: parsed.title,
      createdAt: parsed.createdAt,
      fileName,
    });
  }

  entries.sort((a, b) => {
    if (a.createdAt === b.createdAt) return b.id.localeCompare(a.id);
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return entries.slice(0, Math.max(0, limit));
}

/**
 * 解析 createRecord 写入的 frontmatter（逐行，无 YAML 依赖）。
 * @param text markdown 全文
 * @returns 解析结果；无效时 null
 */
function parseRecordFrontmatter(text: string): {
  id: string;
  type: RecordType;
  title: string;
  createdAt: string;
} | null {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(4, end);

  let id = '';
  let type: RecordType | undefined;
  let title = '';
  let createdAt = '';

  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (key === 'id') id = raw;
    else if (key === 'type') type = normalizeType(raw);
    else if (key === 'title') title = unquoteYamlValue(raw);
    else if (key === 'createdAt') createdAt = raw;
  }

  if (!id || !type || !title || !createdAt) return null;
  return { id, type, title, createdAt };
}

/**
 * 还原 yamlEscape 写出的值（JSON 字符串或裸字符串）。
 * @param value frontmatter 值
 * @returns 原始字符串
 */
function unquoteYamlValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 创建 record 文件（惰性创建 records/）。
 * @param cwd 项目根
 * @param input 创建参数
 * @returns 创建的 record 元数据
 */
export function createRecord(cwd: string, input: CreateRecordInput): SkegRecord {
  const dir = join(cwd, SKEG_DIR, 'records');
  mkdirSync(dir, { recursive: true });

  const seq = nextSequence(dir, input.type);
  const id = `${PREFIX[input.type]}-${String(seq).padStart(3, '0')}`;
  const slug = slugify(input.title);
  const fileName = `${id}-${slug}.md`;
  const relativePath = `.skeg/records/${fileName}`;
  const createdAt = new Date().toISOString();
  const body = (input.body || '').trim();

  const markdown = [
    '---',
    `type: ${input.type}`,
    `id: ${id}`,
    `title: ${yamlEscape(input.title)}`,
    input.run?.id ? `runId: ${input.run.id}` : null,
    `createdAt: ${createdAt}`,
    '---',
    '',
    `# ${input.title}`,
    '',
    body || '_(no body)_',
    '',
    input.run
      ? [
          '## Context',
          '',
          `- Run: ${input.run.id}`,
          `- Intent: ${input.run.intent}`,
          `- Risk: ${input.run.risk} (${input.run.riskSource})`,
          input.run.changedFiles.length > 0
            ? `- Files: ${input.run.changedFiles.join(', ')}`
            : null,
          '',
        ]
          .filter((line) => line !== null)
          .join('\n')
      : '',
  ]
    .filter((line) => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  writeFileSync(join(dir, fileName), markdown, 'utf8');

  return {
    id,
    type: input.type,
    title: input.title,
    body,
    runId: input.run?.id,
    createdAt,
    fileName,
    relativePath,
  };
}

/**
 * 规范化类型别名。
 * @param value 用户输入
 * @returns RecordType 或 undefined
 */
export function normalizeType(value: string | undefined): RecordType | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'decision' || v === 'dec' || v === 'adr') return 'decision';
  if (v === 'migration' || v === 'mig') return 'migration';
  if (v === 'incident' || v === 'inc') return 'incident';
  return undefined;
}

/**
 * 扫描目录生成下一序号。
 * @param dir records 目录
 * @param type record 类型
 * @returns 下一序号
 */
function nextSequence(dir: string, type: RecordType): number {
  if (!existsSync(dir)) return 1;
  const prefix = `${PREFIX[type]}-`;
  let max = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const match = name.match(new RegExp(`^${PREFIX[type]}-(\\d+)`));
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * 标题转文件名 slug。
 * @param title 标题
 * @returns slug
 */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'record';
}

/**
 * 简单 YAML 字符串转义。
 * @param value 原始值
 * @returns 可写入 frontmatter 的值
 */
function yamlEscape(value: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || value.includes('\n')) {
    return JSON.stringify(value);
  }
  return value;
}
