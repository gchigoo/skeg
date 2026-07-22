/**
 * Shell 退出码完整性：检测测试退出状态是否可能被 Shell 逻辑掩盖。
 */
export type ExitIntegrity = 'preserved' | 'masked';

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
 * 判断命令的退出状态是否可信地来自被匹配的检查命令。
 * 保守策略：`||`、`;`、管道 `|`、后台 `&`、显式 `exit 0`、换行 → masked。
 * `&&` 链与 env 前缀视为 preserved。
 * @param command bash 命令
 * @returns preserved | masked
 */
export function inspectExitIntegrity(command: string): ExitIntegrity {
  const raw = command.trim();
  if (!raw) return 'masked';

  // 换行视为复合命令
  if (/[\r\n]/.test(raw)) return 'masked';

  const stripped = stripQuotedRegions(raw);

  if (/\|\|/.test(stripped)) return 'masked';
  if (/;/.test(stripped)) return 'masked';
  // 单个 |（管道）；|| 已先处理
  if (/(^|[^|])\|([^|]|$)/.test(stripped)) return 'masked';
  if (/\bexit\s+0\b/i.test(stripped)) return 'masked';

  // `&&` 为允许的链式执行；去掉后再查剩余 `&`（后台）
  const withoutRedirects = stripRedirections(stripped).replace(/&&/g, ' ');
  if (/&/.test(withoutRedirects)) return 'masked';

  return 'preserved';
}
