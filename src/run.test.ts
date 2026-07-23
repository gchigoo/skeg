import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduce } from './reducer.ts';
import {
  applyAdvisoryRisk,
  applyRiskHit,
  closeRun,
  createRun,
  formatStatus,
  hasCliFlag,
  isOpenRun,
  latestRunFromEntries,
  resolveGate,
  upsertCheck,
} from './run.ts';

describe('hasCliFlag', () => {
  it('matches leading --flag (\\b would fail)', () => {
    assert.equal(hasCliFlag('--force', '--force'), true);
    assert.equal(hasCliFlag('--abandon', 'abandon'), true);
    assert.equal(hasCliFlag('--force --verbose', '--force'), true);
    assert.equal(hasCliFlag('  --abandon  ', '--abandon'), true);
  });

  it('rejects partial or missing flags', () => {
    assert.equal(hasCliFlag('--forceful', '--force'), false);
    assert.equal(hasCliFlag('', '--force'), false);
    assert.equal(hasCliFlag(undefined, '--abandon'), false);
  });
});

describe('createRun', () => {
  it('starts lean orient active schema v2', () => {
    const run = createRun('fix redirect');
    assert.equal(run.status, 'active');
    assert.equal(run.phase, 'orient');
    assert.equal(run.risk, 'lean');
    assert.equal(run.riskSource, 'advisory');
    assert.equal(run.schemaVersion, 2);
    assert.equal(run.revision, 0);
    assert.deepEqual(run.signals, []);
    assert.deepEqual(run.gates, []);
    assert.deepEqual(run.waivers, []);
  });
});

describe('risk layers', () => {
  it('deterministic hit upgrades and blocks', () => {
    const run = createRun('migrate');
    const next = applyRiskHit(run, {
      trigger: 'databaseMigration',
      strength: 'deterministic',
      path: 'migrations/1.sql',
      reason: 'migration',
    });
    assert.equal(next.risk, 'guarded');
    assert.equal(next.riskSource, 'deterministic');
    assert.equal(next.status, 'blocked');
    assert.ok(next.pendingGate);
  });

  it('advisory cannot downgrade deterministic', () => {
    let run = createRun('x');
    run = applyRiskHit(run, {
      trigger: 'dependencyChange',
      strength: 'deterministic',
      path: 'package.json',
      reason: 'deps',
    });
    run = resolveGate(run);
    const next = applyAdvisoryRisk(run, 'lean');
    assert.equal(next.risk, 'guarded');
    assert.equal(next.riskSource, 'deterministic');
  });
});

describe('latestRunFromEntries', () => {
  it('reads newest veritack/run custom entry', () => {
    const a = createRun('first');
    const b = createRun('second');
    const found = latestRunFromEntries([
      { type: 'custom', customType: 'veritack/run', data: a },
      { type: 'custom', customType: 'other', data: {} },
      { type: 'custom', customType: 'veritack/run', data: b },
    ]);
    assert.equal(found?.intent, 'second');
  });
});

describe('closeRun', () => {
  it('marks done and not open', () => {
    const run = closeRun(createRun('x'), 'done');
    assert.equal(run.status, 'done');
    assert.equal(isOpenRun(run), false);
  });
});

describe('formatStatus bounded', () => {
  it('summarizes many stale checks', () => {
    let run = createRun('long status');
    for (let i = 0; i < 12; i++) {
      run = upsertCheck(run, {
        kind: 'command',
        name: `c${i}`,
        passed: true,
      });
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: [`f${i}.ts`],
      });
    }
    run = upsertCheck(run, {
      kind: 'diff',
      name: 'diff',
      passed: true,
    });
    const text = formatStatus(run);
    assert.match(text, /pass:diff@r12/);
    assert.match(text, /\+\d+ stale \(r\d+–r\d+\)/);
    const staleListed = (text.match(/\(stale\)/g) ?? []).length;
    assert.ok(staleListed <= 8);
  });

  it('lists recent resolved gates', () => {
    let run = createRun('gates');
    run = applyRiskHit(run, {
      trigger: 'protectedPaths',
      strength: 'deterministic',
      path: '.env',
      reason: 'secret',
    });
    run = resolveGate(run);
    run = reduce(run, { type: 'GATE_CLEARED' });
    const text = formatStatus(run);
    assert.match(text, /Resolved:.*approved:protectedPaths/);
  });
});
