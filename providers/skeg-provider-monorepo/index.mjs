/**
 * skeg-provider-monorepo：workspace 定向测试命令的 CheckProvider。
 * 只依赖公共契约形状；运行时零依赖。
 */

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
    return { kind: 'command', name: 'test' };
  }

  // turbo run test --filter=<pkg> | turbo test --filter=<pkg>
  if (
    /^turbo(?:\.js)?\s+(?:run\s+)?test\b/i.test(cmd) &&
    /--filter(?:=|\s+)\S+/i.test(cmd)
  ) {
    return { kind: 'command', name: 'test' };
  }

  // nx test <project>
  if (/^nx\s+test\s+\S+/i.test(cmd)) {
    return { kind: 'command', name: 'test' };
  }

  return null;
}

/** @type {import('@gchigoo/skeg/provider-api').SkegProviderV1} */
const provider = {
  apiVersion: 1,
  id: 'monorepo',
  capabilities: ['check'],
  checks: { classify },
};

export default provider;
