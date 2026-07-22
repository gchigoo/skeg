import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduce } from './reducer.ts';
import { createRun, formatStatus, upsertCheck } from './run.ts';

describe('reduce CHECK_RECORDED', () => {
  it('preserves evidence source for provenance display', () => {
    let run = createRun('prov');
    run = upsertCheck(run, {
      kind: 'command',
      name: 'test',
      passed: true,
      command: 'pnpm --filter app test',
      source: 'provider:monorepo',
    });
    assert.equal(run.checks[0]?.source, 'provider:monorepo');
    assert.match(formatStatus(run), /provider:monorepo/);
  });
});

describe('reduce MUTATION_COMMITTED', () => {
  it('bumps revision and invalidates prior checks as stale', () => {
    let run = createRun('x');
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
    });
    assert.equal(run.revision, 0);
    assert.equal(run.checks[0]?.revision, 0);
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['a.ts'] });
    assert.equal(run.revision, 1);
    assert.equal(run.phase, 'change');
    assert.ok(run.changedFiles.includes('a.ts'));
    // 旧 check 保留但 revision 不等
    assert.equal(run.checks[0]?.revision, 0);
    assert.notEqual(run.checks[0]?.revision, run.revision);
  });

  it('returns from prove to change on mutation', () => {
    let run = createRun('x');
    run = reduce(run, { type: 'PHASE_SET', phase: 'prove' });
    run = reduce(run, { type: 'MUTATION_COMMITTED', paths: ['b.ts'] });
    assert.equal(run.phase, 'change');
  });
});
