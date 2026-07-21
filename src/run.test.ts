import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAdvisoryRisk,
  applyRiskHit,
  closeRun,
  createRun,
  isOpenRun,
  latestRunFromEntries,
  resolveGate,
} from './run.ts';

describe('createRun', () => {
  it('starts lean orient active', () => {
    const run = createRun('fix redirect');
    assert.equal(run.status, 'active');
    assert.equal(run.phase, 'orient');
    assert.equal(run.risk, 'lean');
    assert.equal(run.riskSource, 'advisory');
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
  it('reads newest skeg/run custom entry', () => {
    const a = createRun('first');
    const b = createRun('second');
    const found = latestRunFromEntries([
      { type: 'custom', customType: 'skeg/run', data: a },
      { type: 'custom', customType: 'other', data: {} },
      { type: 'custom', customType: 'skeg/run', data: b },
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
