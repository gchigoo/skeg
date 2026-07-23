/**
 * @veritack/rust：cargo 验证命令的 CheckProvider。
 * 只依赖公共契约形状；运行时零依赖。
 */

/**
 * 是否为 cargo test 的非执行模式（只编译/列测试，不跑测试）。
 * @param {string} cmd
 * @returns {boolean}
 */
function isNonExecutingCargoTest(cmd) {
  // cargo test --no-run / --doc --no-run 等
  if (/(?:^|\s)--no-run(?:\s|$)/i.test(cmd)) return true;
  // cargo test -- --list / -- --list --format terse
  if (/\s--\s+.*(?:^|\s)--list(?:\s|$)/i.test(cmd) || /\s--\s+--list(?:\s|$)/i.test(cmd)) {
    return true;
  }
  if (/(?:^|\s)--list(?:\s|$)/i.test(cmd) && !/\s--\s/.test(cmd)) {
    // rare: cargo test --list (without -- separator)
    return true;
  }
  return false;
}

/**
 * 是否为 cargo nextest 的非执行模式。
 * @param {string} cmd
 * @returns {boolean}
 */
function isNonExecutingNextest(cmd) {
  // 只接受 `cargo nextest run ...`；list/archive/show 等均拒绝
  if (!/^cargo\s+nextest\s+run(?:\s|$)/i.test(cmd)) return true;
  if (/(?:^|\s)--help(?:\s|$)/i.test(cmd) || /(?:^|\s)-h(?:\s|$)/i.test(cmd)) {
    return true;
  }
  if (/(?:^|\s)--dry-run(?:\s|$)/i.test(cmd)) return true;
  return false;
}

/**
 * @param {string} command
 * @returns {{ kind: 'command'; name: string } | null}
 */
function classify(command) {
  const cmd = command.trim();
  if (!cmd) return null;

  // cargo nextest run ...（排除 list/archive 等）
  if (/^cargo\s+nextest(?:\s|$)/i.test(cmd)) {
    if (isNonExecutingNextest(cmd)) return null;
    return { kind: 'command', name: 'test' };
  }

  // cargo test ...（排除 --no-run / --list）
  if (/^cargo\s+test(?:\s|$)/i.test(cmd)) {
    if (isNonExecutingCargoTest(cmd)) return null;
    return { kind: 'command', name: 'test' };
  }

  if (/^cargo\s+clippy(?:\s|$)/i.test(cmd)) {
    return { kind: 'command', name: 'lint' };
  }

  if (
    /^cargo\s+fmt\s+--\s*--check(?:\s|$)/i.test(cmd) ||
    /^cargo\s+fmt\s+--check(?:\s|$)/i.test(cmd)
  ) {
    return { kind: 'command', name: 'fmt' };
  }

  return null;
}

/** @type {import('@veritack/pi-veritack/provider-api').VeritackProviderV1} */
const provider = {
  apiVersion: 1,
  id: 'rust',
  capabilities: ['check'],
  checks: { classify },
};

export default provider;
