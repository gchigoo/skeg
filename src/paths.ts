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
 * 判断路径是否匹配任一 glob。
 * @param path 文件路径
 * @param patterns glob 列表
 * @returns 是否匹配
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
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
