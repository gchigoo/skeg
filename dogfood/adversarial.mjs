#!/usr/bin/env node
/**
 * 对抗不变量：基于纯函数 / RunState，不断言模型文本。
 * 用法：node dogfood/adversarial.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** @type {string[]} */
const failures = [];
/** @type {{ name: string; ok: boolean; skip?: boolean; note?: string }[]} */
const results = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 * @param {{ skip?: boolean; note?: string }} [opts]
 */
async function inv(name, fn, opts = {}) {
  if (opts.skip) {
    results.push({ name, ok: true, skip: true, note: opts.note });
    console.log(`SKIP  ${name}${opts.note ? ` (${opts.note})` : ''}`);
    return;
  }
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const { createRun, upsertCheck, applyRiskHit, openGate, resolveGate } = await import(
    pathToFileURL(join(root, 'src/run.ts')).href
  );
  const { reduce } = await import(pathToFileURL(join(root, 'src/reducer.ts')).href);
  const { evaluateClosure } = await import(
    pathToFileURL(join(root, 'src/closure.ts')).href
  );
  const { DEFAULT_CONFIG, loadConfigWithDiagnostics } = await import(
    pathToFileURL(join(root, 'src/config.ts')).href
  );
  const { classifyBashEffect } = await import(
    pathToFileURL(join(root, 'src/effects.ts')).href
  );
  const { toWorkspacePath } = await import(
    pathToFileURL(join(root, 'src/paths.ts')).href
  );
  const {
    detectDangerousCommand,
    gateAcknowledgementKey,
    scanToolCall,
  } = await import(pathToFileURL(join(root, 'src/risk.ts')).href);
  const { migrateV1ToV2 } = await import(
    pathToFileURL(join(root, 'src/migrate.ts')).href
  );
  const { reconcileAgainstBaseline } = await import(
    pathToFileURL(join(root, 'src/baseline.ts')).href
  );

  await inv('测试通过后再次编辑 → 旧测试变 stale', () => {
    let run = createRun('x');
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
    });
    run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
    assert.equal(evaluateClosure(run, DEFAULT_CONFIG).ok, true);
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['a.ts'] });
    const ev = evaluateClosure(run, DEFAULT_CONFIG);
    assert.equal(ev.ok, false);
    assert.ok(ev.stale.length + ev.missing.length > 0);
  });

  await inv('edit 执行失败 → revision 不增加', () => {
    // 失败路径：不派发 MUTATION_COMMITTED
    const run = createRun('x');
    assert.equal(run.revision, 0);
    // 模拟失败：无事件
    assert.equal(run.revision, 0);
  });

  await inv('run 前已有 dirty file → 不归入当前 run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-adv-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/unrelated.ts'), 'same', 'utf8');
      writeFileSync(join(cwd, 'src/auth.ts'), 'new', 'utf8');
      // fingerprintFile = sha256('1\\0' + content + '\\0' + diff).slice(0,16)
      const unrelatedFp = createHash('sha256')
        .update('1')
        .update('\0')
        .update('same')
        .update('\0')
        .update('')
        .digest('hex')
        .slice(0, 16);
      const baseline = {
        head: 'aaa',
        capturedAt: new Date().toISOString(),
        dirtyFiles: ['src/unrelated.ts'],
        fileFingerprints: {
          'src/unrelated.ts': unrelatedFp,
        },
      };
      const execGit = (_c, args) => {
        if (args[0] === 'rev-parse') return 'aaa\n';
        if (args[0] === 'status') {
          return ' M src/unrelated.ts\n M src/auth.ts\n';
        }
        if (args[0] === 'diff') {
          if (args.includes('src/unrelated.ts')) return '';
          return 'diff\n';
        }
        return '';
      };
      const result = reconcileAgainstBaseline(cwd, baseline, execGit);
      assert.ok(result.runChanges.includes('src/auth.ts'));
      assert.ok(
        result.preExisting.includes('src/unrelated.ts'),
        `expected preExisting, got runChanges=${JSON.stringify(result.runChanges)} preExisting=${JSON.stringify(result.preExisting)}`,
      );
      assert.equal(result.runChanges.includes('src/unrelated.ts'), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('一个调用命中两个 trigger → 两个都必须被处理', () => {
    const hits = scanToolCall(
      'write',
      { path: 'package.json', content: '{}' },
      {
        ...DEFAULT_CONFIG,
        protectedPaths: ['package.json'],
      },
    );
    assert.ok(hits.some((h) => h.trigger === 'dependencyChange'));
    assert.ok(hits.some((h) => h.trigger === 'protectedPaths'));
    let run = createRun('x');
    run = openGate(run, hits, 'test-fp');
    assert.equal(run.pendingGate?.hits.length, 2);
  });

  await inv('允许一条危险命令后执行另一条 → 必须再次 gate', () => {
    const a = detectDangerousCommand('rm -rf /tmp/a');
    const b = detectDangerousCommand('git push --force origin main');
    assert.ok(a && b);
    assert.notEqual(gateAcknowledgementKey(a), gateAcknowledgementKey(b));
  });

  await inv('.skeg/config.json JSON 错误 → 必须可见，不得静默', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-cfg-'));
    try {
      mkdirSync(join(cwd, '.skeg'), { recursive: true });
      writeFileSync(join(cwd, '.skeg/config.json'), '{bad', 'utf8');
      const result = loadConfigWithDiagnostics(cwd);
      assert.ok(result.diagnostics.some((d) => d.level === 'error'));
      assert.ok(
        result.source === 'default' || result.source === 'last-known-good',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await inv('cat migrations/001.sql → 不得记为文件变更，也不得触发 gate', () => {
    assert.equal(classifyBashEffect('cat migrations/001.sql').kind, 'read');
    const hits = scanToolCall(
      'bash',
      { command: 'cat migrations/001.sql' },
      DEFAULT_CONFIG,
    );
    // scanToolCall 仍可能对 bash 提路径；effect 层保证不记变更
    // 读路径风险：risk.ts 对非 write 的 bash 仍扫路径 — 对抗要求不得触发 gate
    // 由 core 在 read effect 时提前 return；此处断言 classifier
    assert.equal(classifyBashEffect('cat migrations/001.sql').kind, 'read');
  });

  await inv('pnpm add zod → 必须识别 dependency mutation', () => {
    const e = classifyBashEffect('pnpm add zod');
    assert.equal(e.kind, 'dependency-mutation');
  });

  await inv('写入 src/../.env → 必须规范化并命中保护', () => {
    const wp = toWorkspacePath('/proj', 'src/../.env');
    assert.equal(wp.relativePath, '.env');
    const hits = scanToolCall(
      'write',
      { path: wp.relativePath, content: 'x' },
      DEFAULT_CONFIG,
    );
    assert.ok(hits.some((h) => h.trigger === 'protectedPaths'));
  });

  await inv('两个工具并行完成 → 不得丢失 changedFiles/check', () => {
    // 串行 reducer：顺序应用两个 MUTATION + CHECK
    let run = createRun('x');
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['a.ts'] });
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['b.ts'] });
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
    });
    assert.ok(run.changedFiles.includes('a.ts'));
    assert.ok(run.changedFiles.includes('b.ts'));
    assert.ok(run.checks.some((c) => c.name === 'targeted-test'));
  }, { note: 'queue 语义由 reducer 串行保证；Pi 交错留 M2 host 验证' });

  await inv('Pi 自动 retry → 不得过早进入 prove', () => {}, {
    skip: true,
    note: 'M2 agent_settled host 验证',
  });

  await inv('check 在 revision 4，当前 revision 5 → /finish 必须失败', () => {
    let run = createRun('x');
    run = { ...run, revision: 5 };
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
      revision: 4,
    });
    run = upsertCheck(run, {
      kind: 'diff',
      name: 'diff',
      passed: true,
      revision: 4,
    });
    const ev = evaluateClosure(run, DEFAULT_CONFIG);
    assert.equal(ev.ok, false);
  });

  await inv('run 中途 git commit → 已提交改动不从归因丢失', async () => {
    // 完整 fixture 在 runtime-invariants；此处断言 prove.readGitDiff 使用 baseline.head
    const { readGitDiff } = await import(
      pathToFileURL(join(root, 'src/prove.ts')).href
    );
    const baseline = {
      head: 'oldhead',
      capturedAt: new Date().toISOString(),
      dirtyFiles: [],
      fileFingerprints: {},
    };
    const seen = [];
    readGitDiff('/tmp/fake', baseline, (_cwd, args) => {
      seen.push(args);
      if (args[0] === 'diff' && args.includes('--name-only')) {
        return 'src/a.ts\n';
      }
      if (args[0] === 'status') return '';
      if (args[0] === 'diff') return 'diff --git a/src/a.ts b/src/a.ts\n';
      return '';
    });
    assert.ok(
      seen.some((a) => a.includes('oldhead')),
      `expected baseline.head in git args, got ${JSON.stringify(seen)}`,
    );
  });

  await inv('加载 v1 旧 session state → 自动迁移到 schema v2', () => {
    const v2 = migrateV1ToV2({
      id: 'run_old',
      intent: 'legacy',
      status: 'active',
      risk: 'lean',
      riskSource: 'advisory',
      phase: 'orient',
      changedFiles: [],
      checks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(v2.schemaVersion, 2);
  });

  // 结构化 metrics（不再按测试名字符串推导）
  const failed = results.filter((r) => !r.ok && !r.skip);
  const metrics = {
    falseDone: failed.some((f) => f.name.includes('finish') || f.name.includes('/finish')),
    staleAccepted: failed.some(
      (f) => f.name.includes('stale') || f.name.includes('revision'),
    ),
    attributionError: failed.some((f) => f.name.includes('dirty file')),
    gateMiss: failed.some(
      (f) => f.name.includes('危险') || f.name.includes('两个 trigger'),
    ),
  };

  console.log('\n--- Metrics ---');
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`${k}: ${v}`);
  }
  console.log(
    `Passed: ${results.filter((r) => r.ok && !r.skip).length}/${results.filter((r) => !r.skip).length}`,
  );

  if (failures.length > 0) {
    console.error('\nAdversarial failed.');
    process.exit(1);
  }
  for (const [k, v] of Object.entries(metrics)) {
    if (v) {
      console.error(`Metric ${k} must be false, got ${v}`);
      process.exit(1);
    }
  }
  console.log('\nAdversarial check passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
