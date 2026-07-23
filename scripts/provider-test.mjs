#!/usr/bin/env node
/**
 * 第三方 Provider conformance：manifest / schema / 确定性 / 异常 / 耗时。
 * 主进程 spawn 子进程（--worker）执行检查，超时 10s 防止挂死。
 * 用法：npx skeg-provider-test ./path/to/provider.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MAX_MS = 50;
const WORKER_TIMEOUT_MS = 10_000;
const selfPath = fileURLToPath(import.meta.url);
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * @param {string} msg
 */
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
}

/**
 * @param {string} msg
 */
function pass(msg) {
  console.log(`PASS  ${msg}`);
}

/**
 * 子进程：执行全部 conformance 检查。
 * @param {string} target Provider 路径
 */
async function runWorker(target) {
  const abs = resolve(process.cwd(), target);
  const mod = await import(pathToFileURL(abs).href);
  const provider = mod.default ?? mod;

  if (provider.apiVersion !== 1) {
    fail(`apiVersion must be 1 (got ${String(provider.apiVersion)})`);
  } else {
    pass('apiVersion === 1');
  }

  if (typeof provider.id !== 'string' || !provider.id.trim()) {
    fail('id must be a non-empty string');
  } else {
    pass(`id: ${provider.id}`);
  }

  if (!Array.isArray(provider.capabilities) || provider.capabilities.length === 0) {
    fail('capabilities must be a non-empty array');
  } else {
    pass(`capabilities: ${provider.capabilities.join(',')}`);
  }

  const { DEFAULT_CONFIG } = await import(
    pathToFileURL(resolve(root, 'src/config.ts')).href
  );
  const {
    validateRiskHits,
    validateClassifiedCheck,
    validateRecordEntries,
  } = await import(
    pathToFileURL(resolve(root, 'src/providervalidate.ts')).href
  );

  const action = {
    toolName: 'write',
    input: { path: 'migrations/001.sql' },
    paths: ['migrations/001.sql'],
  };

  if (provider.policies?.inspect) {
    const t0 = Date.now();
    let a;
    let b;
    try {
      a = provider.policies.inspect(action, DEFAULT_CONFIG);
      b = provider.policies.inspect(action, DEFAULT_CONFIG);
    } catch (err) {
      fail(`policies.inspect threw: ${err instanceof Error ? err.message : err}`);
      a = [];
      b = [];
    }
    const elapsed = Date.now() - t0;
    if (elapsed > MAX_MS * 2) {
      fail(`policies.inspect exceeded time budget (${elapsed}ms)`);
    } else {
      pass(`policies.inspect within budget (${elapsed}ms)`);
    }
    assert.deepEqual(a, b);
    pass('policies.inspect is deterministic');
    const validated = validateRiskHits(a, `provider:${provider.id}`, 'conformance');
    if (validated.diagnostics.length > 0) {
      fail(
        `policies.inspect schema issues: ${validated.diagnostics.map((d) => d.message).join('; ')}`,
      );
    } else {
      pass('policies.inspect schema ok');
    }
  }

  if (provider.checks?.classify) {
    const samples = [
      'pnpm test',
      'just skeg-special-verify',
      'echo hello',
    ];
    for (const command of samples) {
      const t0 = Date.now();
      let a;
      let b;
      try {
        a = provider.checks.classify(command, DEFAULT_CONFIG);
        b = provider.checks.classify(command, DEFAULT_CONFIG);
      } catch (err) {
        fail(
          `checks.classify threw on ${command}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      if (Date.now() - t0 > MAX_MS) {
        fail(`checks.classify slow on ${command}`);
      }
      assert.deepEqual(a, b);
      const validated = validateClassifiedCheck(
        a,
        `provider:${provider.id}`,
        'conformance',
      );
      if (validated.diagnostics.length > 0) {
        fail(
          `checks.classify schema: ${validated.diagnostics.map((d) => d.message).join('; ')}`,
        );
      }
    }
    pass('checks.classify deterministic + schema');
  }

  if (provider.records?.select) {
    const ctx = { cwd: process.cwd(), intent: 'test', changedFiles: ['a.ts'] };
    let a;
    let b;
    try {
      a = provider.records.select(ctx);
      b = provider.records.select(ctx);
    } catch (err) {
      fail(`records.select threw: ${err instanceof Error ? err.message : err}`);
      a = [];
      b = [];
    }
    assert.deepEqual(a, b);
    pass('records.select deterministic');
    const records = Array.isArray(a)
      ? a
      : a && typeof a === 'object' && Array.isArray(a.records)
        ? a.records
        : null;
    if (records) {
      const validated = validateRecordEntries(records, 'conformance');
      if (validated.diagnostics.length > 0) {
        fail(
          `records schema: ${validated.diagnostics.map((d) => d.message).join('; ')}`,
        );
      } else {
        pass('records.select schema ok');
      }
    } else {
      fail('records.select must return array or {mode,records}');
    }
  }

  if (process.exitCode) {
    console.error('\nProvider conformance failed.');
    process.exit(1);
  }
  console.log('\nProvider conformance passed.');
}

/**
 * 主进程：spawn worker，透传 stdout/stderr，超时失败。
 * @param {string} target Provider 路径
 */
function runParent(target) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', selfPath, '--worker', target],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: WORKER_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      console.error('FAIL  provider conformance (timeout or crash)');
      process.exit(1);
    }
    console.error(`FAIL  provider conformance (spawn error: ${result.error.message})`);
    process.exit(1);
  }

  if (result.status === null) {
    console.error('FAIL  provider conformance (timeout or crash)');
    process.exit(1);
  }

  process.exit(result.status === 0 ? 0 : result.status ?? 1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    const target = args[1];
    if (!target) {
      console.error('Usage: skeg-provider-test --worker <provider-module>');
      process.exit(2);
    }
    await runWorker(target);
    return;
  }

  const target = args[0];
  if (!target) {
    console.error('Usage: skeg-provider-test <provider-module>');
    process.exit(2);
  }
  runParent(target);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
