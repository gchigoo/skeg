import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import {
  analyzeProveSnapshot,
  healChangedFilesFromGit,
  runProveChecks,
} from './prove.ts';
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

  it('raises sensitive-keywords as signal not failed check', () => {
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
    assert.equal(
      analysis.checks.some((c) => c.name === 'sensitive-keywords'),
      false,
    );
    const sens = analysis.signals.find((s) => s.trigger === 'sensitive-keywords');
    assert.ok(sens);
    assert.equal(analysis.upgradeGuarded, true);
    assert.match(sens?.evidence ?? '', /session/);
  });

  it('skips sensitive signal when authPaths configured', () => {
    const run = createRun('x');
    const analysis = analyzeProveSnapshot(
      { available: true, files: ['a.ts'], diff: SAMPLE_DIFF },
      run,
      { ...DEFAULT_CONFIG, authPaths: ['src/auth/**'] },
    );
    assert.equal(
      analysis.signals.some((s) => s.trigger === 'sensitive-keywords'),
      false,
    );
  });

  it('raises public-api-export signal when apiPaths empty', () => {
    const run = createRun('x');
    const analysis = analyzeProveSnapshot(
      { available: true, files: ['src/auth/logout.ts'], diff: SAMPLE_DIFF },
      run,
      DEFAULT_CONFIG,
    );
    const api = analysis.signals.find((s) => s.trigger === 'public-api-export');
    assert.ok(api);
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
  it('writes checks and signals onto run via injected git', () => {
    const run = createRun('fix avatar');
    const { run: next, notes } = runProveChecks(
      '/tmp/fake',
      run,
      DEFAULT_CONFIG,
      (_cwd, args) => {
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'status') return ' M src/auth/logout.ts\n';
        if (args.includes('--name-only')) return 'src/auth/logout.ts\n';
        return SAMPLE_DIFF;
      },
    );
    assert.equal(next.phase, 'prove');
    assert.ok(next.checks.some((c) => c.name === 'diff'));
    assert.ok(next.signals.some((s) => s.trigger === 'sensitive-keywords'));
    assert.equal(next.risk, 'guarded');
    assert.ok(notes.length > 0);
  });
});

describe('healChangedFilesFromGit', () => {
  it('advances orient → change when git shows files', () => {
    const run = createRun('stuck in orient');
    assert.equal(run.phase, 'orient');
    const next = healChangedFilesFromGit('/tmp/fake', run, (_cwd, args) => {
      if (args[0] === 'status') return ' M .gitignore\n';
      if (args.includes('--name-only')) return '.gitignore\n';
      if (args[0] === 'rev-parse') return 'abc\n';
      return '';
    });
    assert.equal(next.phase, 'change');
    assert.ok(next.changedFiles.includes('.gitignore'));
  });

  it('no-ops when already in change with files', () => {
    let run = createRun('already tracking');
    run = { ...run, phase: 'change', changedFiles: ['a.ts'] };
    const next = healChangedFilesFromGit('/tmp/fake', run, () => {
      throw new Error('git should not be called');
    });
    assert.equal(next, run);
  });

  it('no-ops when git has no changes', () => {
    const run = createRun('clean tree');
    const next = healChangedFilesFromGit('/tmp/fake', run, () => '');
    assert.equal(next.phase, 'orient');
    assert.equal(next.changedFiles.length, 0);
  });
});
