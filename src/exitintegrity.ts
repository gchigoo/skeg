/**
 * Shell 退出码完整性：检测测试退出状态是否可能被 Shell 逻辑掩盖。
 * 支持 unwrap bash/sh/zsh/powershell/cmd wrapper 并递归检查 payload。
 */

export type ExitIntegrity = 'preserved' | 'masked';

export type ShellWrapper =
  | { kind: 'posix'; shell: string; payload: string }
  | { kind: 'powershell'; payload: string }
  | { kind: 'cmd'; payload: string };

/**
 * 剥离单/双引号内文本，避免把引号内的操作符误判为 shell 控制符。
 * @param command 原始命令
 * @returns 剥离后的扫描文本
 */
function stripQuotedRegions(command: string): string {
  let out = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < command.length && command[i] !== quote) {
        // 双引号内允许 \"；单引号无转义
        if (quote === '"' && command[i] === '\\' && i + 1 < command.length) {
          i += 2;
          continue;
        }
        i += 1;
      }
      out += ' ';
      if (i < command.length) i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 去掉常见重定向，避免把 `2>&1` / `>&2` / `&>` 中的 `&` 当成后台符。
 * @param text 已剥离引号的命令
 * @returns 清洗后的文本
 */
function stripRedirections(text: string): string {
  return text
    .replace(/\d*>&\d+/g, ' ')
    .replace(/&>/g, ' ')
    .replace(/\d*>>?/g, ' ')
    .replace(/</g, ' ');
}

/**
 * 从引号或裸参数中提取 -c / -Command 后的 payload。
 * @param command 完整命令
 * @param flagRe flag 正则（已含捕获）
 * @returns payload 或 null
 */
function extractFlagPayload(
  command: string,
  flagRe: RegExp,
): string | null {
  const match = command.match(flagRe);
  if (!match) return null;
  const rest = command.slice(match.index! + match[0].length).trim();
  if (!rest) return null;
  if (rest[0] === "'" || rest[0] === '"') {
    const quote = rest[0];
    let i = 1;
    let out = '';
    while (i < rest.length) {
      if (quote === '"' && rest[i] === '\\' && i + 1 < rest.length) {
        out += rest[i + 1];
        i += 2;
        continue;
      }
      if (rest[i] === quote) return out;
      out += rest[i];
      i += 1;
    }
    return out;
  }
  // 裸参数：取到管道/重定向前
  const bare = rest.match(/^([^\s|&;]+)/);
  return bare?.[1] ?? null;
}

/**
 * 识别常见 shell wrapper 并提取内层 payload。
 * @param command 原始命令
 * @returns wrapper 或 null
 */
export function unwrapShellWrapper(command: string): ShellWrapper | null {
  const raw = command.trim();
  if (!raw) return null;

  const posix = extractFlagPayload(
    raw,
    /(?:^|[;&|]\s*)(?:\/(?:usr\/)?bin\/)?(?:bash|sh|zsh)\s+(?:-[a-zA-Z]*c|-lc)\s+/i,
  );
  if (posix !== null) {
    const shellMatch = raw.match(/\b(bash|sh|zsh)\b/i);
    return {
      kind: 'posix',
      shell: (shellMatch?.[1] ?? 'sh').toLowerCase(),
      payload: posix,
    };
  }

  const pwsh = extractFlagPayload(
    raw,
    /(?:^|[;&|]\s*)(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-Command|-c)\s+/i,
  );
  if (pwsh !== null) {
    return { kind: 'powershell', payload: pwsh };
  }

  const cmd = extractFlagPayload(
    raw,
    /(?:^|[;&|]\s*)(?:cmd(?:\.exe)?)\s+(?:\/[cCkK])\s+/i,
  );
  if (cmd !== null) {
    return { kind: 'cmd', payload: cmd };
  }

  return null;
}

/**
 * 按 shell 方言扫描退出状态是否可能被掩盖。
 * @param command 命令（已是最终扫描文本）
 * @param dialect posix | powershell | cmd
 * @returns preserved | masked
 */
function inspectDialect(
  command: string,
  dialect: 'posix' | 'powershell' | 'cmd',
): ExitIntegrity {
  const raw = command.trim();
  if (!raw) return 'masked';
  if (/[\r\n]/.test(raw)) return 'masked';

  const stripped = stripQuotedRegions(raw);

  if (dialect === 'cmd') {
    if (/&/.test(stripped)) return 'masked';
    if (/\|/.test(stripped)) return 'masked';
    if (/\bexit\s*\/b\s*0\b/i.test(stripped)) return 'masked';
    if (/\bexit\s+0\b/i.test(stripped)) return 'masked';
    return 'preserved';
  }

  if (dialect === 'powershell') {
    if (/;/.test(stripped)) return 'masked';
    if (/(^|[^|])\|([^|]|$)/.test(stripped)) return 'masked';
    if (/\bexit\s+0\b/i.test(stripped)) return 'masked';
    return 'preserved';
  }

  // posix
  if (/\|\|/.test(stripped)) return 'masked';
  if (/;/.test(stripped)) return 'masked';
  if (/(^|[^|])\|([^|]|$)/.test(stripped)) return 'masked';
  if (/\bexit\s+0\b/i.test(stripped)) return 'masked';
  const withoutRedirects = stripRedirections(stripped).replace(/&&/g, ' ');
  if (/&/.test(withoutRedirects)) return 'masked';
  return 'preserved';
}

/**
 * 判断命令的退出状态是否可信地来自被匹配的检查命令。
 * 识别 shell wrapper 时递归检查 payload。
 * @param command bash 命令
 * @returns preserved | masked
 */
export function inspectExitIntegrity(command: string): ExitIntegrity {
  const raw = command.trim();
  if (!raw) return 'masked';

  const wrapper = unwrapShellWrapper(raw);
  if (wrapper) {
    if (wrapper.kind === 'posix') {
      // 内层再 unwrap 一层（少见嵌套）
      const nested = unwrapShellWrapper(wrapper.payload);
      if (nested) return inspectExitIntegrity(wrapper.payload);
      return inspectDialect(wrapper.payload, 'posix');
    }
    if (wrapper.kind === 'powershell') {
      return inspectDialect(wrapper.payload, 'powershell');
    }
    return inspectDialect(wrapper.payload, 'cmd');
  }

  return inspectDialect(raw, 'posix');
}

/**
 * 用于 check 分类的有效命令文本：wrapper 时用 payload。
 * @param command 原始命令
 * @returns 分类用文本
 */
export function commandForCheckClassification(command: string): string {
  const wrapper = unwrapShellWrapper(command.trim());
  return wrapper ? wrapper.payload : command.trim();
}
