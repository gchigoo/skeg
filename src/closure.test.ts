import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { evaluateClosure, formatClosureFailure } from './closure.ts';
import { runProveChecks } from './prove.ts';
import { reduce } from './reducer.ts';
import { createRun, upsertCheck } from './run.ts';

describe('evaluateClosure', () => {
  it('rejects missing required checks', () => {
    const run = createRun('x');
    const ev = evaluateClosure(run, DEFAULT_CONFIG);
    assert.equal(ev.ok, false);
    assert.ok(ev.missing.includes('targeted-test'));
    assert.ok(ev.missing.includes('diff'));
  });

  it('rejects stale evidence after mutation', () => {
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
    assert.ok(ev.stale.includes('targeted-test') || ev.missing.includes('targeted-test'));
    assert.match(formatClosureFailure(ev, run), /Cannot finish/);
  });

  it('accepts waive for current revision only', () => {
    let run = createRun('x');
    run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
    run = reduce(run, {
      type: 'WAIVER_ADDED',
      waiver: {
        reason: 'hotfix',
        missingChecks: ['targeted-test'],
        revision: run.revision,
      },
    });
    assert.equal(evaluateClosure(run, DEFAULT_CONFIG).ok, true);
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['b.ts'] });
    assert.equal(evaluateClosure(run, DEFAULT_CONFIG).ok, false);
  });

  it('rejects unresolved requiresGate signals', () => {
    let run = createRun('x');
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
    });
    run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
    assert.equal(evaluateClosure(run, DEFAULT_CONFIG).ok, true);
    run = reduce(run, {
      type: 'SIGNAL_RAISED',
      signal: {
        trigger: 'custom-policy',
        strength: 'deterministic',
        evidence: 'needs human ack',
        requiresGate: true,
        acknowledged: false,
      },
    });
    const ev = evaluateClosure(run, DEFAULT_CONFIG);
    assert.equal(ev.ok, false);
    assert.equal(ev.unresolvedSignals.length, 1);
    assert.match(formatClosureFailure(ev, run), /Unresolved signals/);
  });

  it('keeps signal requiredChecks after revision bump when prove replays', () => {
    // requiredChecks 只在当前 revision 生效；signal 源必须 settle 重放
    const SAMPLE = `
diff --git a/src/auth/logout.ts b/src/auth/logout.ts
--- a/src/auth/logout.ts
+++ b/src/auth/logout.ts
@@ -1,1 +1,3 @@
+export function clearSession() {
+  // drop session cookie
+}
`;
    let run = createRun('signal replay');
    run = { ...run, changedFiles: ['src/auth/logout.ts'], phase: 'change' };
    const execGit = (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return ' M src/auth/logout.ts\n';
      if (args.includes('--name-only')) return 'src/auth/logout.ts\n';
      if (args[0] === 'diff' && args.includes('--cached')) return '';
      return SAMPLE;
    };
    let proved = runProveChecks('/tmp/fake', run, DEFAULT_CONFIG, execGit);
    run = proved.run;
    const revN = run.revision;
    assert.ok(
      run.signals.some(
        (s) =>
          s.revision === revN &&
          s.trigger === 'sensitive-keywords' &&
          (s.requiredChecks ?? []).includes('targeted-test'),
      ),
    );
    // 无关编辑 bump revision
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['unrelated.ts'] });
    assert.equal(run.revision, revN + 1);
    // 再次 prove（固定 diff）必须重放 signal 到新 revision
    proved = runProveChecks('/tmp/fake', run, DEFAULT_CONFIG, execGit);
    run = proved.run;
    const ev = evaluateClosure(run, DEFAULT_CONFIG);
    assert.ok(
      run.signals.some(
        (s) =>
          s.revision === run.revision &&
          (s.requiredChecks ?? []).includes('targeted-test'),
      ),
    );
    assert.ok(
      ev.missing.includes('targeted-test') ||
        ev.stale.includes('targeted-test'),
    );
  });
});
