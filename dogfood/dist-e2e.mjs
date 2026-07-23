#!/usr/bin/env node
/**
 * 分发端到端：npm pack tarball → 干净沙箱安装 Provider → 装载 veritack →
 * trust → 第三方 policy/check → finish closure。
 *
 * 用法：node dogfood/dist-e2e.mjs
 * 确定性、无 LLM。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmExecArgs } from './npm-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/** providers/ 下目录名（包名为 @veritack/<name>） */
const PROVIDER_NAMES = ['postgres', 'monorepo', 'rust'];

/** @type {string[]} */
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [opts]
 */
function run(cwd, args, opts = {}) {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/**
 * @param {string} cwd
 * @param {string[]} npmArgs
 * @returns {string}
 */
function runNpm(cwd, npmArgs) {
  const { file, args, shell } = npmExecArgs(npmArgs);
  return run(cwd, [file, ...args], {
    env: { ...process.env, npm_config_cache: join(tmpdir(), 'veritack-npm-cache') },
    shell: Boolean(shell),
  });
}

/**
 * @param {string} cwd
 * @returns {string} tarball 绝对路径
 */
function npmPack(cwd) {
  const out = runNpm(cwd, ['pack', '--json']);
  // npm pack --json 可能混有进度日志；取最后一段 JSON
  const trimmed = out.trim();
  const start = trimmed.indexOf('[');
  const startObj = trimmed.indexOf('{');
  const jsonStart =
    start === -1
      ? startObj
      : startObj === -1
        ? start
        : Math.min(start, startObj);
  const parsed = JSON.parse(jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed);
  const filename = Array.isArray(parsed) ? parsed[0].filename : parsed.filename;
  return join(cwd, filename);
}

/**
 * 解包 npm tarball 到目标目录（去掉顶层 package/）。
 * @param {string} tarball
 * @param {string} dest
 */
function extractPackage(tarball, dest) {
  mkdirSync(dest, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'veritack-extract-'));
  try {
    run(staging, ['tar', '-xzf', tarball, '-C', staging]);
    const pkgDir = join(staging, 'package');
    assert.ok(existsSync(pkgDir), `missing package/ in ${tarball}`);
    cpSync(pkgDir, dest, { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'veritack-dist-e2e-'));
  const packs = join(work, 'packs');
  const sandbox = join(work, 'sandbox');
  const pkgExtract = join(work, 'veritack-pkg');
  const userDir = join(work, 'user');
  mkdirSync(packs, { recursive: true });
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(userDir, { recursive: true });

  const prevUserDir = process.env.VERITACK_USER_DIR;
  process.env.VERITACK_USER_DIR = userDir;

  try {
    console.log(`Work: ${work}`);

    // --- pack ---
    const pkgTarball = npmPack(REPO);
    const pkgPackCopy = join(packs, pkgTarball.split(/[/\\]/).pop());
    cpSync(pkgTarball, pkgPackCopy);
    rmSync(pkgTarball);
    check('npm pack veritack', existsSync(pkgPackCopy), pkgPackCopy);

    /** @type {string[]} */
    const providerTarballs = [];
    for (const name of PROVIDER_NAMES) {
      const dir = join(REPO, 'providers', name);
      const tgz = npmPack(dir);
      const copy = join(packs, tgz.split(/[/\\]/).pop());
      cpSync(tgz, copy);
      rmSync(tgz);
      providerTarballs.push(copy);
      check(`npm pack ${name}`, existsSync(copy), copy);
    }

    // --- extract veritack (outside node_modules; strip-types friendly) ---
    extractPackage(pkgPackCopy, pkgExtract);
    const requiredFiles = [
      'extensions/core.ts',
      'src/provider-api.ts',
      'dist/provider-api.js',
      'dist/provider-api.d.ts',
      'src/providers.ts',
      'src/trust.ts',
      'src/hostsession.ts',
      'package.json',
    ];
    for (const f of requiredFiles) {
      check(`veritack tarball contains ${f}`, existsSync(join(pkgExtract, f)));
    }

    // 干净沙箱：正式入口 import('@veritack/pi-veritack/provider-api')
    const apiSandbox = join(work, 'api-import');
    mkdirSync(apiSandbox, { recursive: true });
    writeFileSync(
      join(apiSandbox, 'package.json'),
      JSON.stringify(
        {
          name: 'veritack-api-import',
          version: '0.0.0',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
      'utf8',
    );
    runNpm(apiSandbox, ['install', pkgPackCopy]);
    const apiMod = await import(
      pathToFileURL(
        join(apiSandbox, 'node_modules', '@veritack', 'pi-veritack', 'dist', 'provider-api.js'),
      ).href
    );
    check(
      'DistEntryImportable defineProvider',
      typeof apiMod.defineProvider === 'function' &&
        apiMod.VERITACK_PROVIDER_API_VERSION === 1,
    );

    // --- sandbox fixture ---
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(
        {
          name: 'veritack-dist-sandbox',
          version: '0.0.0',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
      'utf8',
    );
    mkdirSync(join(sandbox, 'migrations'), { recursive: true });
    mkdirSync(join(sandbox, 'src'), { recursive: true });
    writeFileSync(join(sandbox, 'src/app.ts'), 'export const x = 1;\n', 'utf8');
    mkdirSync(join(sandbox, '.veritack'), { recursive: true });
    writeFileSync(
      join(sandbox, '.veritack/config.json'),
      JSON.stringify(
        {
          checks: {
            default: ['test', 'diff'],
            guarded: ['test', 'diff'],
          },
          providers: [
            {
              id: 'postgres',
              spec: '@veritack/postgres',
              required: true,
              priority: 10,
            },
            {
              id: 'monorepo',
              spec: '@veritack/monorepo',
              required: false,
              priority: 5,
            },
            {
              id: 'rust',
              spec: '@veritack/rust',
              required: false,
              priority: 5,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    run(sandbox, ['git', 'init']);
    run(sandbox, ['git', 'config', 'user.email', 'veritack@dist.local']);
    run(sandbox, ['git', 'config', 'user.name', 'veritack-dist']);
    run(sandbox, ['git', 'add', '-A']);
    run(sandbox, ['git', 'commit', '-m', 'init']);

    // --- install providers into sandbox node_modules ---
    runNpm(sandbox, [
      'install',
      '--no-save',
      '--no-package-lock',
      ...providerTarballs,
    ]);
    for (const name of PROVIDER_NAMES) {
      const pkg = `@veritack/${name}`;
      check(
        `installed ${pkg}`,
        existsSync(join(sandbox, 'node_modules', '@veritack', name, 'index.mjs')),
      );
    }

    // peer 依赖：从源仓库 node_modules 链接，模拟干净环境中已安装 Pi
    const peerName = '@earendil-works/pi-coding-agent';
    const peerSrc = join(REPO, 'node_modules', peerName);
    const peerDest = join(pkgExtract, 'node_modules', peerName);
    if (existsSync(peerSrc)) {
      mkdirSync(dirname(peerDest), { recursive: true });
      cpSync(peerSrc, peerDest, { recursive: true });
    }

    // --- load veritack modules from extracted tarball ---
    const pkgImport = (rel) =>
      import(pathToFileURL(join(pkgExtract, rel)).href);

    // 证明 extensions/core.ts 可从 tarball 装载（不执行完整 Pi 注册）
    const coreMod = await pkgImport('extensions/core.ts');
    check(
      'load extensions/core.ts from tarball',
      typeof coreMod.default === 'function',
      typeof coreMod.default,
    );

    const { trustProvider } = await pkgImport('src/trust.ts');
    const {
      loadProviders,
      mergePolicyHits,
      classifyWithProviders,
    } = await pkgImport('src/providers.ts');
    const { loadConfig } = await pkgImport('src/config.ts');
    const { classifyCheckCommand } = await pkgImport('src/checks.ts');
    const { createRun, upsertCheck, openGate, resolveGate, formatStatus } =
      await pkgImport('src/run.ts');
    const { evaluateClosure } = await pkgImport('src/closure.ts');
    const { scanToolCall } = await pkgImport('src/risk.ts');

    const config = loadConfig(sandbox);

    // --- trust package specs ---
    for (const name of PROVIDER_NAMES) {
      const pkg = `@veritack/${name}`;
      const result = trustProvider(sandbox, pkg);
      check(`trust ${pkg}`, result.ok === true, result.message || '');
    }

    const loaded = await loadProviders(sandbox, config);
    check(
      'providers loaded from node_modules packages',
      loaded.policies.length === 1 && loaded.checks.length === 2,
      `policies=${loaded.policies.length} checks=${loaded.checks.length} diag=${JSON.stringify(loaded.diagnostics)}`,
    );
    check(
      'no load diagnostics errors',
      !loaded.diagnostics.some((d) => d.level === 'error'),
      loaded.diagnostics.map((d) => d.message).join('; '),
    );

    // --- postgres policy on migration write ---
    const migPath = 'migrations/002_users.sql';
    // 含 DROP COLUMN：与 builtin 路径命中去重后仍保留带 fingerprint 的 provider hit
    const migContent =
      'ALTER TABLE users DROP COLUMN legacy_flag;\n';
    writeFileSync(join(sandbox, migPath), migContent, 'utf8');
    const action = {
      toolName: 'write',
      input: { path: migPath, content: migContent },
      paths: [migPath],
    };
    const builtinHits = scanToolCall('write', action.input, config);
    const merged = mergePolicyHits(
      builtinHits,
      action,
      config,
      loaded.policies,
    );
    const providerHits = merged.hits.filter(
      (h) => h.source === 'provider:postgres',
    );
    check(
      'postgres PolicyProvider hits on migration write',
      providerHits.length >= 1,
      providerHits.map((h) => h.reason).join(' | '),
    );

    let runState = createRun('dist e2e migration + checks');
    runState = openGate(
      runState,
      merged.hits.filter((h) => h.trigger === 'databaseMigration'),
      `write:${migPath}`,
    );
    check(
      'gate opened with provider provenance',
      Boolean(runState.pendingGate) &&
        (runState.pendingGate.hits ?? []).some(
          (h) => h.source === 'provider:postgres',
        ),
    );
    const statusGate = formatStatus(runState);
    check(
      'formatStatus shows provider gate provenance',
      /provider:postgres/i.test(statusGate),
      statusGate.replace(/\n/g, ' | ').slice(0, 240),
    );
    runState = resolveGate(runState);

    // --- monorepo + rust CheckProviders（选用 builtin 不会命中的命令）---
    const monoCmd = 'pnpm --filter app test';
    const rustCmd = 'cargo nextest run';
    const rustLintCmd = 'cargo clippy';
    const monoBuiltin = classifyCheckCommand(monoCmd, config);
    const rustBuiltin = classifyCheckCommand(rustCmd, config);
    const rustLintBuiltin = classifyCheckCommand(rustLintCmd, config);
    if (monoBuiltin || rustBuiltin || rustLintBuiltin) {
      throw new Error(
        `unexpected builtin classify: mono=${JSON.stringify(monoBuiltin)} rust=${JSON.stringify(rustBuiltin)} lint=${JSON.stringify(rustLintBuiltin)} commands=${JSON.stringify(config.checks.commands)}`,
      );
    }

    const mono = classifyWithProviders(
      monoCmd,
      config,
      classifyCheckCommand(monoCmd, config),
      loaded.checks,
    );
    check(
      'monorepo CheckProvider classifies filtered test',
      mono.check?.name === 'test' &&
        mono.check?.source === 'provider:monorepo',
      JSON.stringify(mono.check),
    );

    const rust = classifyWithProviders(
      rustCmd,
      config,
      classifyCheckCommand(rustCmd, config),
      loaded.checks,
    );
    check(
      'rust CheckProvider classifies cargo nextest',
      rust.check?.name === 'test' && rust.check?.source === 'provider:rust',
      JSON.stringify(rust.check),
    );

    const rustLint = classifyWithProviders(
      rustLintCmd,
      config,
      classifyCheckCommand(rustLintCmd, config),
      loaded.checks,
    );
    check(
      'rust CheckProvider classifies cargo clippy as lint',
      rustLint.check?.name === 'lint' &&
        rustLint.check?.source === 'provider:rust',
      JSON.stringify(rustLint.check),
    );

    runState = upsertCheck(runState, {
      kind: 'command',
      name: 'test',
      passed: true,
      command: monoCmd,
      source: mono.check.source,
    });
    runState = upsertCheck(runState, {
      kind: 'diff',
      name: 'diff',
      passed: true,
      source: 'builtin',
    });

    const statusChecks = formatStatus(runState);
    check(
      'formatStatus shows provider check provenance',
      /provider:monorepo/i.test(statusChecks),
      statusChecks.replace(/\n/g, ' | ').slice(0, 240),
    );

    const closure = evaluateClosure(runState, config);
    check(
      'finish closure ok with third-party check evidence',
      closure.ok === true,
      JSON.stringify(closure),
    );

    // 额外：破坏性 SQL shell 命中
    const dropMerged = mergePolicyHits(
      [],
      {
        toolName: 'bash',
        input: { command: 'psql -c "DROP TABLE users"' },
        paths: [],
      },
      config,
      loaded.policies,
    );
    check(
      'postgres detects DROP TABLE in bash',
      dropMerged.hits.some(
        (h) =>
          h.source === 'provider:postgres' &&
          /DROP TABLE/i.test(h.reason),
      ),
      dropMerged.hits.map((h) => h.reason).join(' | '),
    );

    // pack 目录非空证明产物存在
    check(
      'pack artifacts retained',
      readdirSync(packs).filter((n) => n.endsWith('.tgz')).length >= 4,
    );
  } catch (err) {
    check(
      'dist-e2e threw',
      false,
      err instanceof Error ? err.stack || err.message : String(err),
    );
  } finally {
    if (prevUserDir === undefined) delete process.env.VERITACK_USER_DIR;
    else process.env.VERITACK_USER_DIR = prevUserDir;
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`\nResult: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  if (failures.length) {
    console.error(failures.map((f) => `- ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
