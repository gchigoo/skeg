#!/usr/bin/env node
/**
 * 第三方 Provider conformance：manifest / schema / 确定性 / 异常 / 耗时。
 * 可选 `--cases <file>` 跑 Provider 领域语义用例。
 * 主进程 spawn 子进程（--worker）执行检查，超时 10s 防止挂死。
 * 用法：
 *   npx veritack-provider-test ./path/to/provider.mjs
 *   npx veritack-provider-test ./path/to/provider.mjs --cases ./provider-cases.json
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 * @param {string[]} args
 * @returns {{ target: string | null; casesPath: string | null; worker: boolean }}
 */
function parseArgs(args) {
  let worker = false;
  /** @type {string | null} */
  let target = null;
  /** @type {string | null} */
  let casesPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--worker') {
      worker = true;
      continue;
    }
    if (a === '--cases') {
      casesPath = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (!a.startsWith('-') && !target) {
      target = a;
    }
  }
  return { target, casesPath, worker };
}

/**
 * @param {unknown} provider
 * @param {string} casesPath
 * @param {unknown} DEFAULT_CONFIG
 */
function runCases(provider, casesPath, DEFAULT_CONFIG) {
  if (!existsSync(casesPath)) {
    fail(`cases file not found: ${casesPath}`);
    return;
  }
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(casesPath, 'utf8'));
  } catch (err) {
    fail(`cases parse error: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (manifest.schemaVersion !== 1) {
    fail(`cases schemaVersion must be 1 (got ${String(manifest.schemaVersion)})`);
    return;
  }

  const checks = manifest.checks;
  if (checks && provider.checks?.classify) {
    for (const item of checks.accept ?? []) {
      const command = String(item.command ?? '');
      const expectName = String(item.name ?? '');
      const result = provider.checks.classify(command, DEFAULT_CONFIG);
      if (!result || result.name !== expectName) {
        fail(
          `cases accept: ${JSON.stringify(command)} → expected name=${expectName}, got ${JSON.stringify(result)}`,
        );
      } else {
        pass(`cases accept: ${command} → ${expectName}`);
      }
    }
    for (const command of checks.reject ?? []) {
      const result = provider.checks.classify(String(command), DEFAULT_CONFIG);
      if (result != null) {
        fail(
          `cases reject: ${JSON.stringify(command)} → expected null, got ${JSON.stringify(result)}`,
        );
      } else {
        pass(`cases reject: ${command}`);
      }
    }
  } else if (checks) {
    fail('cases.checks present but provider has no checks.classify');
  }

  const policies = manifest.policies;
  if (Array.isArray(policies) && provider.policies?.inspect) {
    for (const item of policies) {
      const action = item.action ?? {};
      const expect = Array.isArray(item.expectTriggers) ? item.expectTriggers : [];
      const hits = provider.policies.inspect(action, DEFAULT_CONFIG) ?? [];
      const got = [...new Set(hits.map((/** @type {any} */ h) => h.trigger))].sort();
      const want = [...new Set(expect)].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fail(
          `cases policy: ${action.toolName ?? '?'} ${JSON.stringify(action.paths ?? [])} → expected triggers ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
        );
      } else {
        pass(
          `cases policy: ${action.toolName ?? '?'} → [${want.join(', ')}]`,
        );
      }
    }
  } else if (policies) {
    fail('cases.policies present but provider has no policies.inspect');
  }
}

/**
 * 子进程：执行全部 conformance 检查。
 * @param {string} target Provider 路径
 * @param {string | null} casesPath
 */
async function runWorker(target, casesPath) {
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
      'just veritack-special-verify',
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

  const resolvedCases =
    casesPath ??
    (existsSync(join(dirname(abs), 'provider-cases.json'))
      ? join(dirname(abs), 'provider-cases.json')
      : null);
  if (resolvedCases) {
    runCases(provider, resolvedCases, DEFAULT_CONFIG);
  }

  if (process.exitCode) {
    console.error('\nProvider conformance failed.');
    process.exit(1);
  }
  console.log('\nProvider conformance passed.');
}

/**
 * 主进程：spawn worker，透传 stdout/stderr，超时失败。
 * @param {string} target
 * @param {string | null} casesPath
 */
function runParent(target, casesPath) {
  const workerArgs = [
    '--experimental-strip-types',
    selfPath,
    '--worker',
    target,
  ];
  if (casesPath) {
    workerArgs.push('--cases', casesPath);
  }
  const result = spawnSync(process.execPath, workerArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: WORKER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });

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
  const { target, casesPath, worker } = parseArgs(process.argv.slice(2));
  if (worker) {
    if (!target) {
      console.error(
        'Usage: veritack-provider-test --worker <provider-module> [--cases <file>]',
      );
      process.exit(2);
    }
    await runWorker(target, casesPath);
    return;
  }

  if (!target) {
    console.error(
      'Usage: veritack-provider-test <provider-module> [--cases <file>]',
    );
    process.exit(2);
  }
  runParent(target, casesPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
