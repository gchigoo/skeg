/**
 * Provider workspace trust：用户级信任存储（仓库外）。
 * 本地 Provider 绑定内容哈希；变更后需重新 trust。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const PROVIDERS_DIR = '.skeg/providers';

/**
 * 用户级 Skeg 目录（可用 SKEG_USER_DIR 覆盖，便于测试）。
 * @returns 绝对路径
 */
export function skegUserDir(): string {
  const override = process.env.SKEG_USER_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.skeg');
}

/**
 * 规范化仓库根路径（用于信任键）。
 * @param cwd 项目根
 * @returns 规范化绝对路径
 */
export function normalizeRepoPath(cwd: string): string {
  return resolve(cwd);
}

/**
 * 校验并分类配置中的 provider spec。
 * 项目内仅允许 `.skeg/providers/**` 相对路径；裸包名走包解析。
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
    const abs = resolve(cwd, classified.relative);
    const rel = relative(resolve(cwd), abs);
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
    return { ok: true, target: pathToFileURL(abs).href, entryPath: abs };
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
 * 读取信任存储。
 * @returns 存储对象
 */
export function loadTrustStore(): TrustStore {
  const file = join(skegUserDir(), TRUST_FILE);
  if (!existsSync(file)) return { providers: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as TrustStore;
    if (!raw || !Array.isArray(raw.providers)) return { providers: [] };
    return {
      providers: raw.providers.filter(
        (p) =>
          p &&
          typeof p.repoRealPath === 'string' &&
          typeof p.spec === 'string' &&
          typeof p.contentHash === 'string',
      ),
    };
  } catch {
    return { providers: [] };
  }
}

/**
 * 写入信任存储。
 * @param store 存储
 */
export function saveTrustStore(store: TrustStore): void {
  const dir = skegUserDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, TRUST_FILE),
    `${JSON.stringify(store, null, 2)}\n`,
    'utf8',
  );
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
      detail: `Provider ${spec.trim()} is not trusted for this workspace. Run /skeg trust ${spec.trim()}`,
    };
  }
  if (entry.contentHash !== hashed.hash) {
    return {
      trusted: false,
      reason: 'hash-mismatch',
      detail: `Provider ${spec.trim()} content changed since trust; run /skeg trust ${spec.trim()} again`,
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
  if (!trimmed) return { ok: false, message: 'Usage: /skeg untrust <spec>' };
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
export function providersConfigHash(providers: string[] | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(providers ?? []))
    .digest('hex');
}
