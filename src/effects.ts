/**
 * Bash 副作用分类：read / mutation / dependency / migration / destructive / unknown。
 */
export type BashEffect =
  | { kind: 'read' }
  | { kind: 'file-mutation'; paths: string[] }
  | { kind: 'dependency-mutation'; ecosystem: string; paths: string[] }
  | { kind: 'migration-execution'; command: string }
  | { kind: 'destructive'; fingerprint: string }
  | { kind: 'unknown' };

const READ_RE =
  /^(?:cat|head|tail|less|more|grep|rg|ag|find|ls|dir|git\s+diff|git\s+status|git\s+log|git\s+show|wc|file|stat|type|Get-Content)\b/i;

const FILE_MUTATION_RE =
  /(?:^|[^0-9])>{1,2}\s*\S+|\btee\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\b(?:cp|mv|rm|touch|truncate|install)\b|\b(?:perl|ruby|python3?)\s+-i\b/i;

const DEP_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:add|remove|uninstall|install|i)\b|\b(?:pip|uv|poetry)\s+(?:add|remove|install)\b|\bcargo\s+(?:add|remove)\b/i;

const MIGRATION_RE =
  /\bprisma\s+migrate\b|\balembic\s+(?:upgrade|downgrade)\b|\brails\s+db:migrate\b|\bdjango(?:-admin)?\s+migrate\b|\bknex\s+migrate\b/i;

const DESTRUCTIVE_RE =
  /\brm\s+(-[a-zA-Z]*f|--recursive)|\bgit\s+push\b.*--force\b|\bDROP\s+(TABLE|DATABASE)\b|\bsudo\b/i;

/**
 * 拆分复合命令（&& ; |）为段落。
 * @param command 原始命令
 * @returns 段落列表
 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n|(?<!\|)\|(?!\|))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 对单段命令分类。
 * @param segment 命令段
 * @returns 副作用
 */
export function classifySegment(segment: string): BashEffect {
  const s = segment.trim();
  if (!s) return { kind: 'unknown' };

  if (DESTRUCTIVE_RE.test(s)) {
    return { kind: 'destructive', fingerprint: s.slice(0, 80) };
  }
  if (MIGRATION_RE.test(s)) {
    return { kind: 'migration-execution', command: s };
  }
  if (DEP_RE.test(s)) {
    let ecosystem = 'unknown';
    if (/\b(?:npm|pnpm|yarn|bun)\b/i.test(s)) ecosystem = 'node';
    else if (/\b(?:pip|uv|poetry)\b/i.test(s)) ecosystem = 'python';
    else if (/\bcargo\b/i.test(s)) ecosystem = 'rust';
    const paths =
      ecosystem === 'node'
        ? ['package.json']
        : ecosystem === 'python'
          ? ['pyproject.toml', 'requirements.txt']
          : ecosystem === 'rust'
            ? ['Cargo.toml']
            : [];
    return { kind: 'dependency-mutation', ecosystem, paths };
  }
  if (FILE_MUTATION_RE.test(s)) {
    return { kind: 'file-mutation', paths: extractMutationPaths(s) };
  }
  // sed without -i 等只读
  if (READ_RE.test(s) || /\bsed\b/i.test(s)) {
    return { kind: 'read' };
  }
  return { kind: 'unknown' };
}

/**
 * 对完整 bash 命令分类：取各段 effect 的优先级合并。
 * 优先级：destructive > migration > dependency > file-mutation > read > unknown
 * @param command bash 命令
 * @returns 合并后的副作用（可能多段时取最高优先级；file-mutation 路径合并）
 */
export function classifyBashEffect(command: string): BashEffect {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return { kind: 'unknown' };

  const effects = segments.map(classifySegment);
  if (effects.some((e) => e.kind === 'destructive')) {
    const d = effects.find((e) => e.kind === 'destructive') as Extract<
      BashEffect,
      { kind: 'destructive' }
    >;
    return d;
  }
  if (effects.some((e) => e.kind === 'migration-execution')) {
    return effects.find((e) => e.kind === 'migration-execution')!;
  }
  const deps = effects.filter(
    (e): e is Extract<BashEffect, { kind: 'dependency-mutation' }> =>
      e.kind === 'dependency-mutation',
  );
  if (deps.length > 0) {
    return {
      kind: 'dependency-mutation',
      ecosystem: deps[0].ecosystem,
      paths: [...new Set(deps.flatMap((d) => d.paths))],
    };
  }
  const muts = effects.filter(
    (e): e is Extract<BashEffect, { kind: 'file-mutation' }> =>
      e.kind === 'file-mutation',
  );
  if (muts.length > 0) {
    return {
      kind: 'file-mutation',
      paths: [...new Set(muts.flatMap((m) => m.paths))],
    };
  }
  if (effects.every((e) => e.kind === 'read')) {
    return { kind: 'read' };
  }
  return { kind: 'unknown' };
}

/**
 * 粗提取 mutation 目标路径。
 * @param segment 命令段
 * @returns 路径列表
 */
function extractMutationPaths(segment: string): string[] {
  const found: string[] = [];
  for (const match of segment.matchAll(/(?:^|[^0-9])>{1,2}\s*([^\s|&;]+)/g)) {
    const token = match[1]?.replace(/^['"]|['"]$/g, '');
    if (token && token !== '/dev/null') found.push(token);
  }
  for (const match of segment.matchAll(
    /\b(?:cp|mv|rm|touch|truncate|install)\b\s+(.+)$/gi,
  )) {
    const args = match[1] ?? '';
    for (const raw of args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
      const token = raw.replace(/^['"]|['"]$/g, '');
      if (token.startsWith('-')) continue;
      if (token.includes('/') || /\.[a-z0-9]+$/i.test(token)) found.push(token);
    }
  }
  return found;
}

/**
 * 是否为会修改工作区的 effect。
 * @param effect 副作用
 * @returns 是否 mutation
 */
export function isMutatingEffect(effect: BashEffect): boolean {
  return (
    effect.kind === 'file-mutation' ||
    effect.kind === 'dependency-mutation' ||
    effect.kind === 'migration-execution' ||
    effect.kind === 'destructive'
  );
}
