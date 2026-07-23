/**
 * @veritack/monorepo：workspace 定向测试命令的 CheckProvider。
 * 只依赖公共契约形状；运行时零依赖。
 */

/**
 * 工具级非执行标志：help / dry-run / list-only。
 * 按实际工具语义判断，不做全局字符串黑名单。
 * @param {string} cmd
 * @param {'pnpm' | 'yarn' | 'turbo' | 'nx'} tool
 * @returns {boolean}
 */
function isNonExecuting(cmd, tool) {
  if (/(?:^|\s)--help(?:\s|$)/i.test(cmd) || /(?:^|\s)-h(?:\s|$)/i.test(cmd)) {
    return true;
  }
  if (tool === 'turbo') {
    if (/(?:^|\s)--dry(?:-run)?(?:=|\s|$)/i.test(cmd)) return true;
    if (/(?:^|\s)--dry=json(?:\s|$)/i.test(cmd)) return true;
  }
  if (tool === 'nx') {
    if (/(?:^|\s)--dry(?:-run)?(?:=|\s|$)/i.test(cmd)) return true;
  }
  // Jest/Vitest list-only 经 package script 透传
  if (/(?:^|\s)--listTests(?:\s|$)/i.test(cmd)) return true;
  if (/(?:^|\s)--list(?:\s|$)/i.test(cmd)) return true;
  if (/(?:^|\s)--passWithNoTests(?:\s|$)/i.test(cmd) && /(?:^|\s)--list/i.test(cmd)) {
    return true;
  }
  return false;
}

/**
 * @param {string} command
 * @returns {{ kind: 'command'; name: string } | null}
 */
function classify(command) {
  const cmd = command.trim();
  if (!cmd) return null;

  // pnpm --filter <pkg> test|run test
  if (
    /^(?:pnpm|yarn)\s+--filter(?:=|\s+)\S+\s+(?:run\s+)?test(?:\s|$)/i.test(cmd)
  ) {
    const tool = /^yarn\b/i.test(cmd) ? 'yarn' : 'pnpm';
    if (isNonExecuting(cmd, tool)) return null;
    return { kind: 'command', name: 'test' };
  }

  // turbo run test --filter=<pkg> | turbo test --filter=<pkg>
  if (
    /^turbo(?:\.js)?\s+(?:run\s+)?test\b/i.test(cmd) &&
    /--filter(?:=|\s+)\S+/i.test(cmd)
  ) {
    if (isNonExecuting(cmd, 'turbo')) return null;
    return { kind: 'command', name: 'test' };
  }

  // nx test <project>
  if (/^nx\s+test\s+\S+/i.test(cmd)) {
    if (isNonExecuting(cmd, 'nx')) return null;
    return { kind: 'command', name: 'test' };
  }

  return null;
}

/** @type {import('@veritack/pi-veritack/provider-api').VeritackProviderV1} */
const provider = {
  apiVersion: 1,
  id: 'monorepo',
  capabilities: ['check'],
  checks: { classify },
};

export default provider;
