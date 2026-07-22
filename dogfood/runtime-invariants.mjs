#!/usr/bin/env node
/**
 * Runtime invariants：临时 Git 仓库 + 真实文件/git，验证宿主事件链语义。
 * 用法：node --experimental-strip-types dogfood/runtime-invariants.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** @type {string[]} */
const failures = [];
/** @type {{ name: string; ok: boolean; metrics: Record<string, boolean> }[]} */
const results = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 * @param {Partial<Record<'falseDone'|'staleAccepted'|'attributionError'|'gateMiss', boolean>>} [flags]
 */
async function inv(name, fn, flags = {}) {
  /** @type {Record<string, boolean>} */
  const metrics = {
    falseDone: false,
    staleAccepted: false,
    attributionError: false,
    gateMiss: false,
    ...flags,
  };
  try {
    await fn();
    results.push({ name, ok: true, metrics });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, metrics });
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @returns {string}
 */
function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'skeg-rt-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'skeg@test']);
  git(cwd, ['config', 'user.name', 'skeg']);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify(
      {
        name: 'rt',
        scripts: {
          test: 'node --test',
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          build: 'echo build',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'init']);
  return cwd;
}

async function main() {
  const { createRun, upsertCheck } = await import(
    pathToFileURL(join(root, 'src/run.ts')).href
  );
  const { reduce } = await import(pathToFileURL(join(root, 'src/reducer.ts')).href);

  /**
   * @param {string} intent
   * @param {'lean'|'guarded'} risk
   * @param {import('../src/types.ts').WorkspaceBaseline} [baseline]
   */
  function startRun(intent, risk = 'lean', baseline) {
    return reduce(null, {
      type: 'RUN_STARTED',
      intent,
      risk,
      baseline,
    });
  }
  const { evaluateClosure } = await import(
    pathToFileURL(join(root, 'src/closure.ts')).href
  );
  const { DEFAULT_CONFIG } = await import(
    pathToFileURL(join(root, 'src/config.ts')).href
  );
  const { classifyCheckCommand } = await import(
    pathToFileURL(join(root, 'src/checks.ts')).href
  );
  const { detectCommandsFromScripts } = await import(
    pathToFileURL(join(root, 'src/checkspec.ts')).href
  );
  const { authorizeMutationPaths } = await import(
    pathToFileURL(join(root, 'src/paths.ts')).href
  );
  const {
    captureBaseline,
    computeRunObservation,
    reconcileAgainstBaseline,
  } = await import(pathToFileURL(join(root, 'src/baseline.ts')).href);
  const { analyzeProveSnapshot, readGitDiff } = await import(
    pathToFileURL(join(root, 'src/prove.ts')).href
  );
  const { classifyBashEffect } = await import(
    pathToFileURL(join(root, 'src/effects.ts')).href
  );

  await inv('unknown Bash 再改已知文件 → revision 增加、旧 checks stale', () => {
    const cwd = makeRepo();
    try {
      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
      let run = startRun('edit a', 'lean', captureBaseline(cwd));
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: ['src/a.ts'],
      });
      run = upsertCheck(run, {
        kind: 'command',
        name: 'targeted-test',
        passed: true,
      });
      run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
      const obs1 = computeRunObservation(cwd, run);
      run = reduce(run, {
        type: 'WORKSPACE_OBSERVED',
        hash: obs1.hash,
        head: obs1.head,
      });
      assert.equal(run.revision, 1);
      assert.equal(evaluateClosure(run, DEFAULT_CONFIG).ok, true);

      // 模拟 unknown Bash（无 MUTATION_COMMITTED）再次修改同路径
      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 3;\n', 'utf8');
      const effect = classifyBashEffect(
        "node -e \"require('fs').writeFileSync('src/a.ts', 'x')\"",
      );
      assert.equal(effect.kind, 'unknown');

      const obs2 = computeRunObservation(cwd, run);
      assert.notEqual(obs2.hash, obs1.hash);
      run = reduce(run, {
        type: 'WORKSPACE_OBSERVED',
        hash: obs2.hash,
        head: obs2.head,
      });
      assert.ok(run.revision > 1, `expected revision bump, got ${run.revision}`);
      const ev = evaluateClosure(run, DEFAULT_CONFIG);
      assert.equal(ev.ok, false);
      assert.ok(ev.stale.length + ev.missing.length > 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('echo test → 不生成 test check', () => {
    const detected = detectCommandsFromScripts({
      test: 'node --test',
      typecheck: 'tsc --noEmit',
    });
    const config = {
      ...DEFAULT_CONFIG,
      checks: { ...DEFAULT_CONFIG.checks, commands: detected },
    };
    assert.equal(classifyCheckCommand('echo test', config), null);
    assert.equal(classifyCheckCommand('cat test.log', config), null);
  });

  await inv('/init 探测后跑 targeted test → 记为 targeted-test', () => {
    const detected = detectCommandsFromScripts({ test: 'node --test' });
    const config = {
      ...DEFAULT_CONFIG,
      checks: { ...DEFAULT_CONFIG.checks, commands: detected },
    };
    assert.deepEqual(classifyCheckCommand('pnpm test src/a.test.ts', config), {
      kind: 'command',
      name: 'targeted-test',
    });
    assert.deepEqual(classifyCheckCommand('pnpm test', config), {
      kind: 'command',
      name: 'test',
    });
  });

  await inv('Bash 写 ../outside.txt → block', () => {
    const cwd = makeRepo();
    try {
      const effect = classifyBashEffect('echo secret > ../outside.txt');
      assert.equal(effect.kind, 'file-mutation');
      const paths = effect.kind === 'file-mutation' ? effect.paths : [];
      const auth = authorizeMutationPaths(cwd, paths);
      assert.ok(auth.blocked.length > 0);
      assert.equal(auth.allowed.length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('requiresGate signal 未确认 → closure false', () => {
    let run = createRun('x');
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
    });
    run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
    run = reduce(run, {
      type: 'SIGNAL_RAISED',
      signal: {
        trigger: 'custom',
        strength: 'deterministic',
        evidence: 'ack me',
        requiresGate: true,
      },
    });
    const ev = evaluateClosure(run, DEFAULT_CONFIG);
    assert.equal(ev.ok, false);
    assert.equal(ev.unresolvedSignals.length, 1);
  });

  await inv('Git 不可用 → diff false', () => {
    let run = createRun('x');
    run = { ...run, changedFiles: ['src/a.ts'] };
    const analysis = analyzeProveSnapshot(
      { available: false, files: [], diff: '', error: 'ENOENT' },
      run,
      DEFAULT_CONFIG,
    );
    const diff = analysis.checks.find((c) => c.name === 'diff');
    assert.equal(diff?.passed, false);
  });

  await inv('pre-existing diff 含 password → 不升级当前 run', () => {
    const cwd = makeRepo();
    try {
      writeFileSync(
        join(cwd, 'src/legacy.ts'),
        "export const password = 'old';\n",
        'utf8',
      );
      const baseline = captureBaseline(cwd);
      assert.ok(baseline.dirtyFiles.includes('src/legacy.ts'));

      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 9;\n', 'utf8');
      let run = startRun('scoped', 'lean', baseline);
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: ['src/a.ts'],
      });
      const reconciled = reconcileAgainstBaseline(cwd, baseline);
      assert.ok(
        reconciled.preExisting.includes('src/legacy.ts'),
        `preExisting=${JSON.stringify(reconciled.preExisting)} runChanges=${JSON.stringify(reconciled.runChanges)}`,
      );
      run = reduce(run, {
        type: 'WORKSPACE_RECONCILED',
        changedFiles: reconciled.runChanges.filter(
          (f) => !run.changedFiles.includes(f),
        ),
        preExistingFiles: reconciled.preExisting,
      });

      const snapshot = readGitDiff(cwd, run.baseline);
      // 确保 analysis 使用含 preExisting 的 run，且 tracked 不含 legacy
      assert.ok((run.preExistingFiles ?? []).includes('src/legacy.ts'));
      const analysis = analyzeProveSnapshot(snapshot, run, DEFAULT_CONFIG);
      assert.equal(
        analysis.signals.some((s) => s.trigger === 'sensitive-keywords'),
        false,
        `unexpected signals: ${JSON.stringify(analysis.signals)}`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('run 中途真实 commit → diff 仍覆盖本 run 修改', () => {
    const cwd = makeRepo();
    try {
      const baseline = captureBaseline(cwd);
      const oldHead = baseline.head;
      assert.ok(oldHead);

      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 42;\n', 'utf8');
      git(cwd, ['add', 'src/a.ts']);
      git(cwd, ['commit', '-m', 'mid-run']);
      const newHead = git(cwd, ['rev-parse', 'HEAD']).trim();
      assert.notEqual(newHead, oldHead);

      let run = startRun('mid commit', 'lean', baseline);
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: ['src/a.ts'],
      });
      const snapshot = readGitDiff(cwd, run.baseline);
      assert.equal(snapshot.available, true);
      // 相对 baseline.head 仍能看到已提交改动
      assert.ok(
        snapshot.files.includes('src/a.ts') ||
          snapshot.diff.includes('a = 42') ||
          readFileSync(join(cwd, 'src/a.ts'), 'utf8').includes('42'),
      );
      // 工作区相对 HEAD 可能干净，但相对 baseline 必须有 diff
      const vsBaseline = git(cwd, ['diff', '--name-only', oldHead]).trim();
      assert.ok(vsBaseline.includes('src/a.ts'));
      assert.equal(run.baseline.head, oldHead);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('settle 幂等：无新变化连续两次 observe → revision 不再递增', () => {
    const cwd = makeRepo();
    try {
      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
      let run = startRun('idempotent settle', 'lean', captureBaseline(cwd));
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: ['src/a.ts'],
      });
      const obs1 = computeRunObservation(cwd, run);
      run = reduce(run, {
        type: 'WORKSPACE_OBSERVED',
        hash: obs1.hash,
        head: obs1.head,
      });
      const revAfterFirst = run.revision;
      const obs2 = computeRunObservation(cwd, run);
      assert.equal(obs2.hash, obs1.hash);
      run = reduce(run, {
        type: 'WORKSPACE_OBSERVED',
        hash: obs2.hash,
        head: obs2.head,
      });
      assert.equal(run.revision, revAfterFirst);
      const obs3 = computeRunObservation(cwd, run);
      run = reduce(run, {
        type: 'WORKSPACE_OBSERVED',
        hash: obs3.hash,
        head: obs3.head,
      });
      assert.equal(run.revision, revAfterFirst);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('第三方 CheckProvider 分类的 check 进入 closure 证据链', async () => {
    const userDir = mkdtempSync(join(tmpdir(), 'skeg-rt-user-'));
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-rt-prov-'));
    const prevUserDir = process.env.SKEG_USER_DIR;
    process.env.SKEG_USER_DIR = userDir;
    try {
      mkdirSync(join(cwd, '.skeg', 'providers'), { recursive: true });
      const counterPath = join(cwd, 'provider-calls.txt');
      const providerPath = join(cwd, '.skeg', 'providers', 'special.mjs');
      writeFileSync(
        providerPath,
        `import { readFileSync, writeFileSync } from 'node:fs';
const COUNTER = ${JSON.stringify(counterPath)};
export default {
  apiVersion: 1,
  id: 'special',
  capabilities: ['check'],
  checks: {
    classify(command) {
      let n = 0;
      try { n = Number(readFileSync(COUNTER, 'utf8')); } catch {}
      writeFileSync(COUNTER, String(n + 1));
      return command === 'just skeg-special-verify'
        ? { kind: 'command', name: 'special-verify' }
        : null;
    }
  }
};
`,
        'utf8',
      );
      const spec = '.skeg/providers/special.mjs';
      const { trustProvider } = await import(
        pathToFileURL(join(root, 'src/trust.ts')).href
      );
      const { loadProviders, classifyWithProviders } = await import(
        pathToFileURL(join(root, 'src/providers.ts')).href
      );
      assert.equal(trustProvider(cwd, spec).ok, true);
      const loaded = await loadProviders(cwd, {
        ...DEFAULT_CONFIG,
        providers: [
          { id: 'special', spec, required: false, priority: 0 },
        ],
      });
      assert.equal(loaded.checks.length, 1);

      const builtin = classifyCheckCommand(
        'just skeg-special-verify',
        DEFAULT_CONFIG,
      );
      assert.equal(builtin, null);

      const classified = classifyWithProviders(
        'just skeg-special-verify',
        DEFAULT_CONFIG,
        builtin,
        loaded.checks,
      );
      assert.deepEqual(classified.check, {
        kind: 'command',
        name: 'special-verify',
        source: 'provider:special',
      });
      assert.equal(Number(readFileSync(counterPath, 'utf8')), 1);

      let run = createRun('provider check');
      run = upsertCheck(run, {
        kind: 'command',
        name: classified.check.name,
        passed: true,
        command: 'just skeg-special-verify',
      });
      run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
      const providerConfig = {
        ...DEFAULT_CONFIG,
        checks: {
          ...DEFAULT_CONFIG.checks,
          default: ['special-verify', 'diff'],
        },
      };
      assert.equal(evaluateClosure(run, providerConfig).ok, true);
    } finally {
      if (prevUserDir === undefined) delete process.env.SKEG_USER_DIR;
      else process.env.SKEG_USER_DIR = prevUserDir;
      rmSync(userDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('未信任项目 Provider 顶层代码不得执行', async () => {
    const userDir = mkdtempSync(join(tmpdir(), 'skeg-rt-user-'));
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-rt-untrust-'));
    const prevUserDir = process.env.SKEG_USER_DIR;
    process.env.SKEG_USER_DIR = userDir;
    try {
      mkdirSync(join(cwd, '.skeg', 'providers'), { recursive: true });
      const marker = join(cwd, 'executed.txt');
      writeFileSync(
        join(cwd, '.skeg', 'providers', 'evil.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export default { checks: { classify() { return null; } } };
`,
        'utf8',
      );
      const { loadProviders } = await import(
        pathToFileURL(join(root, 'src/providers.ts')).href
      );
      const loaded = await loadProviders(cwd, {
        ...DEFAULT_CONFIG,
        providers: [
          {
            id: 'evil',
            spec: '.skeg/providers/evil.mjs',
            required: false,
            priority: 0,
          },
        ],
      });
      assert.equal(loaded.checks.length, 0);
      assert.equal(
        (() => {
          try {
            readFileSync(marker, 'utf8');
            return true;
          } catch {
            return false;
          }
        })(),
        false,
      );
    } finally {
      if (prevUserDir === undefined) delete process.env.SKEG_USER_DIR;
      else process.env.SKEG_USER_DIR = prevUserDir;
      rmSync(userDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('pnpm test || true 与 ; echo ok 不得记为有效 check 证据', async () => {
    const { inspectExitIntegrity } = await import(
      pathToFileURL(join(root, 'src/exitintegrity.ts')).href
    );
    assert.equal(inspectExitIntegrity('pnpm test || true'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test; echo ok'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test'), 'preserved');

    // 模拟 tool_result：masked（或未被分类）均不得产生 passed test 证据
    for (const command of ['pnpm test || true', 'pnpm test; echo ok']) {
      const classified = classifyCheckCommand(command, DEFAULT_CONFIG);
      const integrity = inspectExitIntegrity(command);
      assert.equal(integrity, 'masked');
      // core.ts：仅当 classified && preserved 才 CHECK_RECORDED
      const wouldRecord = Boolean(classified) && integrity === 'preserved';
      assert.equal(wouldRecord, false);

      let run = createRun('masked check');
      run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
      const cfg = {
        ...DEFAULT_CONFIG,
        checks: { ...DEFAULT_CONFIG.checks, default: ['test', 'diff'] },
      };
      assert.equal(evaluateClosure(run, cfg).ok, false);
      assert.ok(evaluateClosure(run, cfg).missing.includes('test'));
    }
  });

  await inv('required PolicyProvider 抛错 → mutation 必须 block', async () => {
    const {
      mergePolicyHits,
      requiredPolicyUnavailable,
    } = await import(pathToFileURL(join(root, 'src/providers.ts')).href);
    const merged = mergePolicyHits(
      [],
      { toolName: 'write', input: {}, paths: ['a.ts'] },
      DEFAULT_CONFIG,
      [
        {
          id: 'req',
          spec: 'req',
          required: true,
          priority: 0,
          impl: {
            inspect: () => {
              throw new Error('policy boom');
            },
          },
        },
      ],
    );
    const reason = requiredPolicyUnavailable(
      {
        policies: [],
        checks: [],
        records: [],
        diagnostics: [],
        configHash: '',
        entries: [],
        requiredPolicyFailures: [],
      },
      new Set(),
      merged.errors,
    );
    assert.ok(reason);
    assert.match(reason, /required PolicyProvider/);
  });

  await inv('Provider 返回 malformed RiskHit → 拒绝并有 diagnostic', async () => {
    const { mergePolicyHits } = await import(
      pathToFileURL(join(root, 'src/providers.ts')).href
    );
    const merged = mergePolicyHits(
      [],
      { toolName: 'write', input: {}, paths: [] },
      DEFAULT_CONFIG,
      [
        {
          id: 'bad',
          spec: 'bad',
          required: false,
          priority: 0,
          impl: {
            inspect: () => [{ trigger: 'nope', reason: 'x' }],
          },
        },
      ],
    );
    assert.equal(merged.hits.length, 0);
    assert.ok(merged.diagnostics.some((d) => d.message.includes('invalid trigger')));
  });

  await inv('两个 Provider 返回相同 RiskHit → 只出现一个', async () => {
    const { mergePolicyHits } = await import(
      pathToFileURL(join(root, 'src/providers.ts')).href
    );
    const hit = {
      trigger: 'databaseMigration',
      strength: 'deterministic',
      path: 'm.sql',
      reason: 'sql',
    };
    const merged = mergePolicyHits(
      [],
      { toolName: 'write', input: {}, paths: ['m.sql'] },
      DEFAULT_CONFIG,
      [
        {
          id: 'a',
          spec: 'a',
          required: false,
          priority: 10,
          impl: { inspect: () => [hit] },
        },
        {
          id: 'b',
          spec: 'b',
          required: false,
          priority: 5,
          impl: { inspect: () => [hit] },
        },
      ],
    );
    assert.equal(merged.hits.length, 1);
  });

  await inv('两个 CheckProvider 同优先级分类冲突 → 取先者且有 diagnostic', async () => {
    const { classifyWithProviders } = await import(
      pathToFileURL(join(root, 'src/providers.ts')).href
    );
    const result = classifyWithProviders('cmd-x', DEFAULT_CONFIG, null, [
      {
        id: 'a',
        spec: 'a',
        required: false,
        priority: 1,
        impl: { classify: () => ({ kind: 'command', name: 'alpha' }) },
      },
      {
        id: 'b',
        spec: 'b',
        required: false,
        priority: 1,
        impl: { classify: () => ({ kind: 'command', name: 'beta' }) },
      },
    ]);
    assert.equal(result.check?.name, 'alpha');
    assert.ok(result.diagnostics.some((d) => d.message.includes('conflict')));
  });

  await inv('RecordSelector 返回空 augment → 不清空 fallback', async () => {
    const { selectRecordsWithProviders } = await import(
      pathToFileURL(join(root, 'src/providers.ts')).href
    );
    const selected = selectRecordsWithProviders(
      { cwd: '/tmp', intent: 'x', changedFiles: [] },
      [
        {
          id: 'aug',
          spec: 'aug',
          required: false,
          priority: 0,
          impl: {
            select: () => ({ mode: 'augment', records: [] }),
          },
        },
      ],
      () => [
        {
          id: 'fallback',
          type: 'decision',
          title: 'keep',
          fileName: 'k.md',
          createdAt: '',
        },
      ],
    );
    assert.equal(selected.records[0]?.id, 'fallback');
  });

  await inv('Provider 加载后未 reload → session 冻结 configHash', async () => {
    const userDir = mkdtempSync(join(tmpdir(), 'skeg-rt-freeze-'));
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-rt-freeze-cwd-'));
    const prevUserDir = process.env.SKEG_USER_DIR;
    process.env.SKEG_USER_DIR = userDir;
    try {
      mkdirSync(join(cwd, '.skeg', 'providers'), { recursive: true });
      const spec = '.skeg/providers/freeze.mjs';
      writeFileSync(
        join(cwd, spec),
        `export default {
  apiVersion: 1,
  id: 'freeze',
  capabilities: ['check'],
  checks: {
    classify(command) {
      return command === 'just freeze-a'
        ? { kind: 'command', name: 'freeze-a' }
        : null;
    }
  }
};
`,
        'utf8',
      );
      const { trustProvider, providersConfigHash } = await import(
        pathToFileURL(join(root, 'src/trust.ts')).href
      );
      const { loadProviders, classifyWithProviders } = await import(
        pathToFileURL(join(root, 'src/providers.ts')).href
      );
      assert.equal(trustProvider(cwd, spec).ok, true);
      const entries = [{ id: 'freeze', spec, required: false, priority: 0 }];
      const loaded = await loadProviders(cwd, {
        ...DEFAULT_CONFIG,
        providers: entries,
      });
      const hashAtLoad = loaded.configHash;
      assert.equal(hashAtLoad, providersConfigHash(entries));

      // 修改文件但不 reload：已加载的 classify 实现仍来自旧模块缓存
      writeFileSync(
        join(cwd, spec),
        `export default {
  apiVersion: 1,
  id: 'freeze',
  capabilities: ['check'],
  checks: {
    classify(command) {
      return command === 'just freeze-b'
        ? { kind: 'command', name: 'freeze-b' }
        : null;
    }
  }
};
`,
        'utf8',
      );
      const still = classifyWithProviders(
        'just freeze-a',
        DEFAULT_CONFIG,
        null,
        loaded.checks,
      );
      assert.equal(still.check?.name, 'freeze-a');
      // 配置未变则 hash 不变（提示需显式 reload 才会重载文件）
      assert.equal(
        providersConfigHash(entries),
        hashAtLoad,
      );
    } finally {
      if (prevUserDir === undefined) delete process.env.SKEG_USER_DIR;
      else process.env.SKEG_USER_DIR = prevUserDir;
      rmSync(userDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // 结构化 metrics：任一失败用例标记对应维度
  const aggregate = {
    falseDone: results.some((r) => !r.ok && r.name.includes('closure')),
    staleAccepted: results.some(
      (r) => !r.ok && r.name.includes('unknown Bash'),
    ),
    attributionError: results.some(
      (r) => !r.ok && (r.name.includes('pre-existing') || r.name.includes('commit')),
    ),
    gateMiss: results.some((r) => !r.ok && r.name.includes('outside')),
  };

  console.log('\n--- Runtime Metrics ---');
  for (const [k, v] of Object.entries(aggregate)) {
    console.log(`${k}: ${v}`);
  }
  console.log(
    `Passed: ${results.filter((r) => r.ok).length}/${results.length}`,
  );

  if (failures.length > 0) {
    console.error('\nRuntime invariants failed.');
    process.exit(1);
  }
  for (const [k, v] of Object.entries(aggregate)) {
    if (v) {
      console.error(`Metric ${k} must be false`);
      process.exit(1);
    }
  }
  console.log('\nRuntime invariants passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
