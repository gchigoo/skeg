/**
 * skeg-provider-postgres：迁移路径写入与破坏性 SQL 的 PolicyProvider。
 * 只依赖公共契约形状；运行时零依赖（JSDoc 类型引用 @gchigoo/skeg/provider-api）。
 */

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
 * @param {{ toolName: string; input: Record<string, unknown>; paths: string[] }} action
 * @returns {Array<{ trigger: string; strength: string; path: string; reason: string; fingerprint?: string }>}
 */
function inspect(action) {
  /** @type {Array<{ trigger: string; strength: string; path: string; reason: string; fingerprint?: string }>} */
  const hits = [];
  const tool = String(action.toolName || '').toLowerCase();

  for (const rawPath of action.paths ?? []) {
    const path = String(rawPath || '').replace(/\\/g, '/');
    if (!path || !isMigrationPath(path)) continue;
    hits.push({
      trigger: 'databaseMigration',
      strength: 'deterministic',
      path,
      reason: `Postgres migration path write: ${path}`,
    });
    const content =
      typeof action.input?.content === 'string' ? action.input.content : '';
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

  if (tool === 'bash' || tool === 'shell') {
    const command =
      typeof action.input?.command === 'string' ? action.input.command : '';
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

/** @type {import('@gchigoo/skeg/provider-api').SkegProviderV1} */
const provider = {
  apiVersion: 1,
  id: 'postgres',
  capabilities: ['policy'],
  policies: { inspect },
};

export default provider;
