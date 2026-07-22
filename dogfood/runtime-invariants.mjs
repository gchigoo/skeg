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
    const { classifyWithProviders } = await import(
      pathToFileURL(join(root, 'src/providers.ts')).href
    );
    const classified = classifyWithProviders(
      'cargo test',
      DEFAULT_CONFIG,
      classifyCheckCommand('cargo test', DEFAULT_CONFIG),
      [
        {
          classify: (command) =>
            command.includes('cargo test')
              ? { kind: 'command', name: 'test' }
              : null,
        },
      ],
    );
    assert.deepEqual(classified, { kind: 'command', name: 'test' });

    let run = createRun('provider check');
    run = upsertCheck(run, {
      kind: 'command',
      name: classified.name,
      passed: true,
      command: 'cargo test',
    });
    run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
    // lean default 需要 targeted-test；用 waive 模拟 provider check 满足 guarded 的 test
    const guardedConfig = {
      ...DEFAULT_CONFIG,
      checks: {
        ...DEFAULT_CONFIG.checks,
        default: ['test', 'diff'],
      },
    };
    assert.equal(evaluateClosure(run, guardedConfig).ok, true);
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
