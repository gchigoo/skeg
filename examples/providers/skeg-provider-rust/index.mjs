/**
 * skeg-provider-rust：cargo 验证命令的 CheckProvider。
 * 只依赖公共契约形状；运行时零依赖。
 */

/**
 * @param {string} command
 * @returns {{ kind: 'command'; name: string } | null}
 */
function classify(command) {
  const cmd = command.trim();
  if (!cmd) return null;

  // cargo nextest run ...
  if (/^cargo\s+nextest\s+run(?:\s|$)/i.test(cmd)) {
    return { kind: 'command', name: 'test' };
  }

  // cargo test ...（排除 cargo test -- --list 等仍计为 test）
  if (/^cargo\s+test(?:\s|$)/i.test(cmd)) {
    return { kind: 'command', name: 'test' };
  }

  if (/^cargo\s+clippy(?:\s|$)/i.test(cmd)) {
    return { kind: 'command', name: 'lint' };
  }

  if (/^cargo\s+fmt\s+--\s*--check(?:\s|$)/i.test(cmd) || /^cargo\s+fmt\s+--check(?:\s|$)/i.test(cmd)) {
    return { kind: 'command', name: 'fmt' };
  }

  return null;
}

/** @type {import('@gchigoo/skeg/provider-api').SkegProviderV1} */
const provider = {
  apiVersion: 1,
  id: 'rust',
  capabilities: ['check'],
  checks: { classify },
};

export default provider;
