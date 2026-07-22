/**
 * Provider 输出边界校验：非法条目丢弃并产出 diagnostic。
 */
import type { ClassifiedCheck } from './checks.ts';
import type { RecordIndexEntry } from './record.ts';
import type {
  ConfigDiagnostic,
  EvidenceSource,
  RiskHit,
  TriggerId,
} from './types.ts';

const TRIGGER_IDS = new Set<TriggerId>([
  'databaseMigration',
  'dependencyChange',
  'protectedPaths',
  'publicApiChange',
  'authChange',
  'dangerousCommand',
  'controlPlane',
]);

const MAX_HITS = 32;
const MAX_REASON = 240;
const MAX_RECORDS = 5;
const CHECK_NAME_RE = /^[a-z0-9-]{1,40}$/;

/**
 * 校验并规范化 RiskHit 列表。
 * @param raw 原始 hits
 * @param source 来源标注
 * @param path 诊断路径
 * @param builtinKeys 已有 builtin 去重键
 * @returns 合法 hits + diagnostics
 */
export function validateRiskHits(
  raw: unknown,
  source: EvidenceSource,
  path: string,
  builtinKeys: ReadonlySet<string> = new Set(),
): { hits: RiskHit[]; diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!Array.isArray(raw)) {
    diagnostics.push({
      level: 'warning',
      path,
      message: 'PolicyProvider.inspect must return an array',
    });
    return { hits: [], diagnostics };
  }
  if (raw.length > MAX_HITS) {
    diagnostics.push({
      level: 'warning',
      path,
      message: `PolicyProvider returned ${raw.length} hits; truncating to ${MAX_HITS}`,
    });
  }

  const hits: RiskHit[] = [];
  const seen = new Set<string>(builtinKeys);
  for (const item of raw.slice(0, MAX_HITS)) {
    if (!item || typeof item !== 'object') {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Skipped malformed RiskHit (not an object)',
      });
      continue;
    }
    const h = item as Record<string, unknown>;
    if (typeof h.trigger !== 'string' || !TRIGGER_IDS.has(h.trigger as TriggerId)) {
      diagnostics.push({
        level: 'warning',
        path,
        message: `Skipped RiskHit with invalid trigger: ${String(h.trigger)}`,
      });
      continue;
    }
    if (
      h.strength !== 'deterministic' &&
      h.strength !== 'semi' &&
      h.strength !== 'weak'
    ) {
      diagnostics.push({
        level: 'warning',
        path,
        message: `Skipped RiskHit with invalid strength: ${String(h.strength)}`,
      });
      continue;
    }
    const reason =
      typeof h.reason === 'string' ? h.reason.slice(0, MAX_REASON) : '';
    if (!reason) {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Skipped RiskHit with empty reason',
      });
      continue;
    }
    const hitPath =
      typeof h.path === 'string'
        ? h.path.replace(/\\/g, '/').replace(/^\.\//, '')
        : '';
    const fingerprint =
      typeof h.fingerprint === 'string' ? h.fingerprint.slice(0, 128) : undefined;
    const key = `${h.trigger}|${hitPath}|${fingerprint ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      trigger: h.trigger as TriggerId,
      strength: h.strength,
      path: hitPath,
      reason,
      fingerprint,
      source,
    });
  }
  return { hits, diagnostics };
}

/**
 * 校验 ClassifiedCheck。
 * @param raw 原始返回值
 * @param source 来源
 * @param path 诊断路径
 * @returns 合法 check 或 null
 */
export function validateClassifiedCheck(
  raw: unknown,
  source: EvidenceSource,
  path: string,
): { check: ClassifiedCheck | null; diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  if (raw == null) return { check: null, diagnostics };
  if (!raw || typeof raw !== 'object') {
    diagnostics.push({
      level: 'warning',
      path,
      message: 'CheckProvider.classify returned non-object',
    });
    return { check: null, diagnostics };
  }
  const c = raw as Record<string, unknown>;
  if (c.kind !== 'command') {
    diagnostics.push({
      level: 'warning',
      path,
      message: `CheckProvider returned unsupported kind: ${String(c.kind)}`,
    });
    return { check: null, diagnostics };
  }
  if (typeof c.name !== 'string' || !CHECK_NAME_RE.test(c.name)) {
    diagnostics.push({
      level: 'warning',
      path,
      message: `CheckProvider returned invalid name: ${String(c.name)}`,
    });
    return { check: null, diagnostics };
  }
  return { check: { kind: 'command', name: c.name, source }, diagnostics };
}

/**
 * 校验 Record 列表。
 * @param raw 原始 records
 * @param path 诊断路径
 * @returns 合法条目
 */
export function validateRecordEntries(
  raw: unknown,
  path: string,
): { records: RecordIndexEntry[]; diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!Array.isArray(raw)) {
    diagnostics.push({
      level: 'warning',
      path,
      message: 'RecordSelector must return an array or {mode,records}',
    });
    return { records: [], diagnostics };
  }
  const records: RecordIndexEntry[] = [];
  for (const item of raw.slice(0, MAX_RECORDS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      typeof r.title !== 'string' ||
      typeof r.fileName !== 'string' ||
      typeof r.createdAt !== 'string' ||
      (r.type !== 'decision' && r.type !== 'migration' && r.type !== 'incident')
    ) {
      diagnostics.push({
        level: 'warning',
        path,
        message: 'Skipped malformed RecordIndexEntry',
      });
      continue;
    }
    records.push({
      id: r.id.slice(0, 64),
      type: r.type,
      title: r.title.slice(0, 200),
      fileName: r.fileName.slice(0, 200),
      createdAt: r.createdAt.slice(0, 64),
    });
  }
  if (raw.length > MAX_RECORDS) {
    diagnostics.push({
      level: 'warning',
      path,
      message: `RecordSelector returned ${raw.length} records; truncating to ${MAX_RECORDS}`,
    });
  }
  return { records, diagnostics };
}

/**
 * RiskHit 去重键。
 * @param hit RiskHit
 * @returns 键
 */
export function riskHitKey(hit: RiskHit): string {
  return `${hit.trigger}|${hit.path}|${hit.fingerprint ?? ''}`;
}
