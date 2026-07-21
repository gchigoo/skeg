/**
 * 路径归一化与 glob 匹配（仅支持 * 与 **，满足风险检测需要）。
 */

/**
 * 将路径统一为正斜杠、去掉前导 ./。
 * @param path 原始路径
 * @returns 归一化路径
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 将 glob 转为正则。支持 `*` 与 `**`。
 * @param pattern glob 模式
 * @returns 正则
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 生成用于 glob 匹配的路径候选（含相对后缀）。
 * 宿主常传绝对路径（如 D:/proj/package.json），需与相对 glob 对齐。
 * @param path 归一化路径
 * @returns 候选路径列表
 */
export function pathMatchCandidates(path: string): string[] {
  const normalized = normalizePath(path);
  const out = new Set<string>([normalized]);
  const parts = normalized.split('/').filter(Boolean);
  let start = 0;
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0])) start = 1;
  for (let i = start; i < parts.length; i++) {
    out.add(parts.slice(i).join('/'));
  }
  return [...out];
}

/**
 * 判断路径是否匹配任一 glob。
 * 对绝对路径同时尝试各相对后缀（package.json、src/auth/** 等）。
 * @param path 文件路径
 * @param patterns glob 列表
 * @returns 是否匹配
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  const candidates = pathMatchCandidates(path);
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern);
    return candidates.some((candidate) => re.test(candidate));
  });
}

/**
 * 从 bash 命令中粗略提取可能写入的路径参数。
 * @param command bash 命令
 * @returns 候选路径
 */
export function extractPathsFromCommand(command: string): string[] {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const paths: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/^['"]|['"]$/g, '');
    if (
      token.includes('/') ||
      token.includes('\\') ||
      token.startsWith('.') ||
      /\.(ts|tsx|js|jsx|json|sql|md|env)$/i.test(token)
    ) {
      paths.push(normalizePath(token));
    }
  }
  return paths;
}

/**
 * 判断 bash 命令是否看起来在写文件（重定向 / tee / sed -i / cp / mv 等）。
 * @param command bash 命令
 * @returns 是否写文件
 */
export function isBashFileWrite(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  // stdout/stderr 合并重定向；排除纯 2> stderr
  if (/(?:^|[^0-9])>{1,2}\s*\S+/.test(c)) return true;
  if (/\btee\b/i.test(c)) return true;
  if (/\bsed\s+(?:-[a-zA-Z]*i|--in-place)/i.test(c)) return true;
  if (/\b(?:cp|mv|install|truncate|touch)\b/i.test(c)) return true;
  if (/\b(?:perl|ruby|python3?)\s+-i\b/i.test(c)) return true;
  return false;
}

/**
 * 从写文件类 bash 命令提取目标路径。
 * @param command bash 命令
 * @returns 写入路径（去重）
 */
export function extractBashWritePaths(command: string): string[] {
  if (!isBashFileWrite(command)) return [];
  const found: string[] = [];

  for (const match of command.matchAll(/(?:^|[^0-9])>{1,2}\s*([^\s|&;]+)/g)) {
    const token = match[1]?.replace(/^['"]|['"]$/g, '');
    if (token && token !== '/dev/null') found.push(normalizePath(token));
  }

  for (const match of command.matchAll(
    /\btee\b(?:\s+-a)?\s+([^\s|&;-][^\s|&;]*)/gi,
  )) {
    const token = match[1]?.replace(/^['"]|['"]$/g, '');
    if (token) found.push(normalizePath(token));
  }

  if (found.length > 0) return [...new Set(found)];
  return [...new Set(extractPathsFromCommand(command))];
}
