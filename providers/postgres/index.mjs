/**
 * @veritack/postgres：迁移路径写入与破坏性 SQL 的 PolicyProvider。
 * 只依赖公共契约形状；运行时零依赖（JSDoc 类型引用 @veritack/pi-veritack/provider-api）。
 */

/** 明确的只读工具名；这些路径命中不产生 migration policy */
const READ_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'search',
  'list',
  'ls',
  'cat',
  'view',
  'open',
]);

/** 明确的写入/变更工具名 */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'create',
  'apply_patch',
  'applypatch',
  'strreplace',
  'multiedit',
  'notebookedit',
  'delete',
  'rm',
  'move',
  'rename',
]);

/**
 * @param {string} path
 * @returns {boolean}
 */
function isMigrationPath(path) {
  const p = path.replace(/\\/g, '/');
  return /(^|\/)migrations\//.test(p) || /\.sql$/i.test(p);
}

/**
 * @param {string} sql
 * @returns {string | null}
 */
function detectDestructiveSql(sql) {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/\bDROP\s+TABLE\b/i.test(text)) return 'DROP TABLE';
  if (/\bTRUNCATE\b/i.test(text)) return 'TRUNCATE';
  if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i.test(text)) {
    return 'ALTER TABLE ... DROP COLUMN';
  }
  // DELETE 无 WHERE（允许换行/多余空白）
  if (/\bDELETE\s+FROM\s+\S+(?:\s+(?!WHERE)\S+)*/i.test(text)) {
    const stmts = text.split(';');
    for (const stmt of stmts) {
      if (/\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) {
        return 'DELETE without WHERE';
      }
    }
  }
  return null;
}

/**
 * 是否应把路径写入视为 migration mutation。
 * 最小实现：已知读工具跳过；已知写工具接受；未知工具在有 content 时保守接受。
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {boolean}
 */
function isMutationAction(tool, input) {
  if (READ_TOOLS.has(tool)) return false;
  if (WRITE_TOOLS.has(tool)) return true;
  // 未知工具：若携带写入内容则视为 mutation（兼容宿主自定义工具名）
  if (typeof input?.content === 'string' && input.content.length > 0) return true;
  return false;
}

/**
 * @param {{ toolName: string; input: Record<string, unknown>; paths: string[] }} action
 * @returns {Array<{ trigger: string; strength: string; path: string; reason: string; fingerprint?: string }>}
 */
function inspect(action) {
  /** @type {Array<{ trigger: string; strength: string; path: string; reason: string; fingerprint?: string }>} */
  const hits = [];
  const tool = String(action.toolName || '').toLowerCase();
  const input = action.input ?? {};

  if (isMutationAction(tool, input)) {
    for (const rawPath of action.paths ?? []) {
      const path = String(rawPath || '').replace(/\\/g, '/');
      if (!path || !isMigrationPath(path)) continue;
      hits.push({
        trigger: 'databaseMigration',
        strength: 'deterministic',
        path,
        reason: `Postgres migration path write: ${path}`,
      });
      const content = typeof input.content === 'string' ? input.content : '';
      const kind = content ? detectDestructiveSql(content) : null;
      if (kind) {
        hits.push({
          trigger: 'databaseMigration',
          strength: 'deterministic',
          path,
          reason: `Destructive SQL in migration (${kind}): ${path}`,
          fingerprint: `sql:${kind}:${path}`,
        });
      }
    }
  }

  if (tool === 'bash' || tool === 'shell') {
    const command = typeof input.command === 'string' ? input.command : '';
    const kind = command ? detectDestructiveSql(command) : null;
    if (kind) {
      hits.push({
        trigger: 'dangerousCommand',
        strength: 'deterministic',
        path: '',
        reason: `Destructive SQL in shell (${kind}): ${command.slice(0, 120)}`,
        fingerprint: `sql-cmd:${kind}:${command.slice(0, 80)}`,
      });
    }
  }

  return hits;
}

/** @type {import('@veritack/pi-veritack/provider-api').VeritackProviderV1} */
const provider = {
  apiVersion: 1,
  id: 'postgres',
  capabilities: ['policy'],
  policies: { inspect },
};

export default provider;
