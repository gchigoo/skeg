import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { analyzeProveSnapshot, runProveChecks } from './prove.ts';
import { createRun } from './run.ts';

const SAMPLE_DIFF = `
diff --git a/src/auth/logout.ts b/src/auth/logout.ts
--- a/src/auth/logout.ts
+++ b/src/auth/logout.ts
@@ -1,3 +1,6 @@
+export function clearSession() {
+  // drop session cookie and current-user cache
+  cache.delete('current-user');
+}
 export function logout() {
+  clearSession();
 }
`;

describe('analyzeProveSnapshot', () => {
  it('records diff check with file list', () => {
    const run = createRun('fix logout cache');
    const analysis = analyzeProveSnapshot(
      {
        available: true,
        files: ['src/auth/logout.ts'],
        diff: SAMPLE_DIFF,
      },
      run,
      DEFAULT_CONFIG,
    );
    const diff = analysis.checks.find((c) => c.name === 'diff');
    assert.ok(diff?.passed);
    assert.match(diff?.evidence ?? '', /logout\.ts/);
  });

  it('flags sensitive keywords and requests guarded upgrade', () => {
    const run = createRun('fix logout cache');
    const analysis = analyzeProveSnapshot(
      {
        available: true,
        files: ['src/auth/logout.ts'],
        diff: SAMPLE_DIFF,
      },
      run,
      DEFAULT_CONFIG,
    );
    const sens = analysis.checks.find((c) => c.name === 'sensitive-keywords');
    assert.equal(sens?.passed, false);
    assert.equal(analysis.upgradeGuarded, true);
    assert.match(sens?.evidence ?? '', /session/);
  });

  it('skips sensitive scan when authPaths configured', () => {
    const run = createRun('x');
    const analysis = analyzeProveSnapshot(
      { available: true, files: ['a.ts'], diff: SAMPLE_DIFF },
      run,
      { ...DEFAULT_CONFIG, authPaths: ['src/auth/**'] },
    );
    const sens = analysis.checks.find((c) => c.name === 'sensitive-keywords');
    assert.equal(sens?.passed, true);
    assert.match(sens?.evidence ?? '', /skipped/);
  });

  it('flags export symbol changes when apiPaths empty', () => {
    const run = createRun('x');
    const analysis = analyzeProveSnapshot(
      { available: true, files: ['src/auth/logout.ts'], diff: SAMPLE_DIFF },
      run,
      DEFAULT_CONFIG,
    );
    const api = analysis.checks.find((c) => c.name === 'public-api-export');
    assert.equal(api?.passed, false);
    assert.match(api?.evidence ?? '', /export/);
  });

  it('fails diff when protected path appears', () => {
    const run = createRun('x');
    const analysis = analyzeProveSnapshot(
      { available: true, files: ['.env.local'], diff: '' },
      run,
      DEFAULT_CONFIG,
    );
    const diff = analysis.checks.find((c) => c.name === 'diff');
    assert.equal(diff?.passed, false);
  });
});

describe('runProveChecks', () => {
  it('writes checks onto run via injected git', () => {
    const run = createRun('fix avatar');
    const { run: next, notes } = runProveChecks(
      '/tmp/fake',
      run,
      DEFAULT_CONFIG,
      (_cwd, args) => {
        if (args[0] === 'status') return ' M src/auth/logout.ts\n';
        if (args.includes('--name-only')) return 'src/auth/logout.ts\n';
        return SAMPLE_DIFF;
      },
    );
    assert.equal(next.phase, 'prove');
    assert.ok(next.checks.some((c) => c.name === 'diff'));
    assert.ok(next.checks.some((c) => c.name === 'sensitive-keywords'));
    assert.equal(next.risk, 'guarded');
    assert.equal(next.riskSource, 'advisory');
    assert.ok(notes.length > 0);
  });
});
