import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { evaluateClosure, formatClosureFailure } from './closure.ts';
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
});
