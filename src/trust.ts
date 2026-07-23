/**
 * Provider workspace trust：用户级信任存储（仓库外）。
 * 本地 Provider 绑定内容哈希；变更后需重新 trust。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRealDescendant, normalizePath, tryRealpath } from './paths.ts';
import type { ConfigDiagnostic } from './types.ts';

export type ProviderTrust = {
  repoRealPath: string;
  spec: string;
  contentHash: string;
  approvedAt: string;
};

export type TrustStore = {
  providers: ProviderTrust[];
};

export type ProviderSpecKind =
  | { ok: true; kind: 'workspace-file'; relative: string }
  | { ok: true; kind: 'package'; name: string }
  | { ok: false; reason: string };

const TRUST_FILE = 'trust.json';
const TRUST_TMP = 'trust.json.tmp';
const PROVIDERS_DIR = '.veritack/providers';

export type TrustStoreLoadResult = {
  store: TrustStore;
  diagnostics: ConfigDiagnostic[];
  /** 损坏时备份路径（若有） */
  corruptBackup?: string;
};

/**
 * 用户级 Veritack 目录（可用 VERITACK_USER_DIR 覆盖，便于测试）。
 * @returns 绝对路径
 */
export function veritackUserDir(): string {
  const override = process.env.VERITACK_USER_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.veritack');
}

/**
 * 规范化仓库根路径（用于信任键；优先 realpath）。
 * @param cwd 项目根
 * @returns 规范化绝对路径
 */
export function normalizeRepoPath(cwd: string): string {
  return tryRealpath(resolve(cwd));
}

/**
 * 检测 workspace Provider 是否含相对路径运行时依赖（禁止多文件 Provider）。
 * @param source 源码文本
 * @returns 违规描述或 null
 */
export function findRelativeRuntimeImport(source: string): string | null {
  // 去掉行注释与块注释，降低误报
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const patterns: RegExp[] = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    const match = re.exec(stripped);
    if (match?.[1]) {
      return `relative import "${match[1]}"`;
    }
  }
  return null;
}

/**
 * 校验 workspace-file Provider 必须为零依赖单文件。
 * @param entryPath 入口绝对路径
 * @returns ok 或错误原因
 */
export function assertSelfContainedProvider(
  entryPath: string,
): { ok: true } | { ok: false; reason: string } {
  let body: string;
  try {
    body = readFileSync(entryPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: `cannot read provider: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const hit = findRelativeRuntimeImport(body);
  if (hit) {
    return {
      ok: false,
      reason: `workspace providers must be self-contained single files (${hit} not allowed)`,
    };
  }
  return { ok: true };
}

/**
 * 校验并分类配置中的 provider spec。
 * 项目内仅允许 `.veritack/providers/**` 相对路径；裸包名走包解析。
 * @param spec 配置字符串
 * @returns 分类结果
 */
export function classifyProviderSpec(spec: string): ProviderSpecKind {
  const trimmed = spec.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty provider spec' };
  }
  if (/^(file|data|http|https):/i.test(trimmed)) {
    return { ok: false, reason: 'URL provider specs are not allowed' };
  }
  if (
    trimmed.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\')
  ) {
    return { ok: false, reason: 'absolute provider paths are not allowed' };
  }
  if (trimmed.includes('..')) {
    return {
      ok: false,
      reason: 'provider path must not contain ".." segments',
    };
  }

  const looksLikePath =
    trimmed.startsWith('.') ||
    /\.(m?[jt]s|c?js)$/i.test(trimmed) ||
    (!trimmed.startsWith('@') &&
      (trimmed.includes('/') || trimmed.includes('\\')));

  if (looksLikePath) {
    const normalized = trimmed
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+/g, '/');
    if (
      !normalized.startsWith(`${PROVIDERS_DIR}/`) ||
      normalized === PROVIDERS_DIR ||
      normalized.endsWith('/')
    ) {
      return {
        ok: false,
        reason: `workspace providers must live under ${PROVIDERS_DIR}/`,
      };
    }
    return { ok: true, kind: 'workspace-file', relative: normalized };
  }

  // 裸包名或 @scope/name
  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2 || !parts[0].slice(1) || !parts[1]) {
      return { ok: false, reason: 'invalid scoped package name' };
    }
  } else if (trimmed.includes('/') || trimmed.includes('\\')) {
    return { ok: false, reason: 'invalid package name' };
  }

  return { ok: true, kind: 'package', name: trimmed };
}

/**
 * 将合法 spec 解析为可 import 的 file URL 或包入口 URL。
 * @param cwd 项目根
 * @param spec 已通过 classify 的原始 spec
 * @returns import 目标
 */
export function resolveTrustedProviderTarget(
  cwd: string,
  spec: string,
): { ok: true; target: string; entryPath: string } | { ok: false; reason: string } {
  const classified = classifyProviderSpec(spec);
  if (!classified.ok) return classified;

  if (classified.kind === 'workspace-file') {
    const repoReal = normalizeRepoPath(cwd);
    const abs = resolve(repoReal, classified.relative);
    const rel = relative(repoReal, abs);
    if (
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      !rel.split(sep).join('/').startsWith(`${PROVIDERS_DIR}/`)
    ) {
      return { ok: false, reason: 'provider path escapes workspace providers dir' };
    }
    if (!existsSync(abs)) {
      return { ok: false, reason: `provider file not found: ${classified.relative}` };
    }
    let entryReal: string;
    try {
      entryReal = realpathSync.native(abs);
    } catch {
      try {
        entryReal = realpathSync(abs);
      } catch {
        return {
          ok: false,
          reason: `cannot resolve provider realpath: ${classified.relative}`,
        };
      }
    }
    if (!isRealDescendant(repoReal, entryReal)) {
      return {
        ok: false,
        reason: 'provider realpath escapes workspace',
      };
    }
    const providersRoot = join(repoReal, PROVIDERS_DIR);
    const providersReal = existsSync(providersRoot)
      ? tryRealpath(providersRoot)
      : resolve(providersRoot);
    const underProviders =
      normalizePath(entryReal) === normalizePath(providersReal) ||
      isRealDescendant(providersReal, dirname(entryReal)) ||
      isRealDescendant(providersReal, entryReal);
    if (!underProviders) {
      return {
        ok: false,
        reason: 'provider realpath escapes .veritack/providers',
      };
    }
    const self = assertSelfContainedProvider(entryReal);
    if (!self.ok) return self;
    return {
      ok: true,
      target: pathToFileURL(entryReal).href,
      entryPath: entryReal,
    };
  }

  try {
    const require = createRequire(join(resolve(cwd), 'package.json'));
    const entryPath = require.resolve(classified.name);
    return { ok: true, target: pathToFileURL(entryPath).href, entryPath };
  } catch (err) {
    return {
      ok: false,
      reason: `failed to resolve package ${classified.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * 计算 Provider 入口文件内容哈希。
 * @param cwd 项目根
 * @param spec provider spec
 * @returns sha256 hex，或错误
 */
export function hashProviderContent(
  cwd: string,
  spec: string,
): { ok: true; hash: string; entryPath: string } | { ok: false; reason: string } {
  const resolved = resolveTrustedProviderTarget(cwd, spec);
  if (!resolved.ok) return resolved;
  const body = readFileSync(resolved.entryPath);
  const hash = createHash('sha256').update(body).digest('hex');
  return { ok: true, hash, entryPath: resolved.entryPath };
}

/**
 * 规范化 trust store 条目。
 * @param raw 解析后对象
 * @returns TrustStore 或 null（结构非法）
 */
function normalizeTrustStore(raw: unknown): TrustStore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const providers = (raw as TrustStore).providers;
  if (!Array.isArray(providers)) return null;
  return {
    providers: providers.filter(
      (p) =>
        p &&
        typeof p.repoRealPath === 'string' &&
        typeof p.spec === 'string' &&
        typeof p.contentHash === 'string',
    ),
  };
}

/**
 * 读取信任存储并返回诊断（损坏时备份原文件）。
 * @returns store + diagnostics
 */
export function loadTrustStoreWithDiagnostics(): TrustStoreLoadResult {
  const file = join(veritackUserDir(), TRUST_FILE);
  if (!existsSync(file)) {
    return { store: { providers: [] }, diagnostics: [] };
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return {
      store: { providers: [] },
      diagnostics: [
        {
          level: 'error',
          path: 'trust.json',
          message: `Cannot read trust store: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const store = normalizeTrustStore(parsed);
    if (!store) {
      return backupCorruptTrust(file, text, 'Trust store root must be { providers: [] }');
    }
    return { store, diagnostics: [] };
  } catch (err) {
    return backupCorruptTrust(
      file,
      text,
      `Trust store JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 损坏 trust.json：备份后返回空 store。
 * @param file 原路径
 * @param text 原内容
 * @param message 诊断消息
 * @returns 空 store + 诊断
 */
function backupCorruptTrust(
  file: string,
  text: string,
  message: string,
): TrustStoreLoadResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(dirname(file), `trust.json.corrupt-${stamp}`);
  try {
    writeFileSync(backup, text, 'utf8');
  } catch {
    return {
      store: { providers: [] },
      diagnostics: [
        {
          level: 'error',
          path: 'trust.json',
          message: `${message}; backup failed — treating as empty trust store`,
        },
      ],
    };
  }
  try {
    // 清空原文件，避免下次重复报错；信任需重新建立
    writeFileSync(file, `${JSON.stringify({ providers: [] }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* 清空失败时仍返回空 store */
  }
  return {
    store: { providers: [] },
    corruptBackup: backup,
    diagnostics: [
      {
        level: 'error',
        path: 'trust.json',
        message: `${message}; backed up to ${backup}; trust store reset (re-trust providers)`,
      },
    ],
  };
}

/**
 * 读取信任存储（忽略诊断；兼容旧调用）。
 * @returns 存储对象
 */
export function loadTrustStore(): TrustStore {
  return loadTrustStoreWithDiagnostics().store;
}

/**
 * 原子写入信任存储（tmp + rename；POSIX mode 0600，Windows 忽略 mode）。
 * @param store 存储
 */
export function saveTrustStore(store: TrustStore): void {
  const dir = veritackUserDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, TRUST_TMP);
  const dest = join(dir, TRUST_FILE);
  const body = `${JSON.stringify(store, null, 2)}\n`;
  // mode 在 Windows 上被忽略；POSIX 限制仅用户可读写
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, dest);
}

export type TrustCheckResult =
  | { trusted: true; contentHash: string }
  | { trusted: false; reason: 'untrusted' | 'hash-mismatch' | 'invalid'; detail: string };

/**
 * 检查 spec 是否在当前仓库被信任且内容哈希匹配。
 * @param cwd 项目根
 * @param spec provider spec
 * @returns 检查结果
 */
export function checkProviderTrust(cwd: string, spec: string): TrustCheckResult {
  const classified = classifyProviderSpec(spec);
  if (!classified.ok) {
    return { trusted: false, reason: 'invalid', detail: classified.reason };
  }

  const hashed = hashProviderContent(cwd, spec);
  if (!hashed.ok) {
    return { trusted: false, reason: 'invalid', detail: hashed.reason };
  }

  const repo = normalizeRepoPath(cwd);
  const store = loadTrustStore();
  const entry = store.providers.find(
    (p) => p.repoRealPath === repo && p.spec === spec.trim(),
  );
  if (!entry) {
    return {
      trusted: false,
      reason: 'untrusted',
      detail: `Provider ${spec.trim()} is not trusted for this workspace. Run /veritack trust ${spec.trim()}`,
    };
  }
  if (entry.contentHash !== hashed.hash) {
    return {
      trusted: false,
      reason: 'hash-mismatch',
      detail: `Provider ${spec.trim()} content changed since trust; run /veritack trust ${spec.trim()} again`,
    };
  }
  return { trusted: true, contentHash: hashed.hash };
}

/**
 * 信任当前内容的 Provider。
 * @param cwd 项目根
 * @param spec provider spec
 * @returns 结果消息
 */
export function trustProvider(
  cwd: string,
  spec: string,
): { ok: true; message: string } | { ok: false; message: string } {
  const trimmed = spec.trim();
  const classified = classifyProviderSpec(trimmed);
  if (!classified.ok) return { ok: false, message: classified.reason };

  const hashed = hashProviderContent(cwd, trimmed);
  if (!hashed.ok) return { ok: false, message: hashed.reason };

  const repo = normalizeRepoPath(cwd);
  const store = loadTrustStore();
  const next: ProviderTrust = {
    repoRealPath: repo,
    spec: trimmed,
    contentHash: hashed.hash,
    approvedAt: new Date().toISOString(),
  };
  const idx = store.providers.findIndex(
    (p) => p.repoRealPath === repo && p.spec === trimmed,
  );
  if (idx >= 0) store.providers[idx] = next;
  else store.providers.push(next);
  saveTrustStore(store);
  return {
    ok: true,
    message: `Trusted ${trimmed} (sha256 ${hashed.hash.slice(0, 12)}…)`,
  };
}

/**
 * 取消信任。
 * @param cwd 项目根
 * @param spec provider spec
 * @returns 结果消息
 */
export function untrustProvider(
  cwd: string,
  spec: string,
): { ok: true; message: string } | { ok: false; message: string } {
  const trimmed = spec.trim();
  if (!trimmed) return { ok: false, message: 'Usage: /veritack untrust <spec>' };
  const repo = normalizeRepoPath(cwd);
  const store = loadTrustStore();
  const before = store.providers.length;
  store.providers = store.providers.filter(
    (p) => !(p.repoRealPath === repo && p.spec === trimmed),
  );
  if (store.providers.length === before) {
    return { ok: false, message: `No trust record for ${trimmed}` };
  }
  saveTrustStore(store);
  return { ok: true, message: `Untrusted ${trimmed}` };
}

/**
 * 配置 providers 列表的稳定哈希（session 缓存键）。
 * @param providers 配置数组
 * @returns hex hash
 */
export function providersConfigHash(providers: unknown[] | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(providers ?? []))
    .digest('hex');
}
