import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrateRunState, migrateV1ToV2 } from './migrate.ts';
import { latestRunFromEntries } from './run.ts';

describe('migrateV1ToV2', () => {
  it('sets schemaVersion 2 and revision 0', () => {
    const v2 = migrateV1ToV2({
      id: 'run_old',
      intent: 'fix me',
      status: 'active',
      risk: 'lean',
      riskSource: 'advisory',
      phase: 'change',
      changedFiles: ['a.ts'],
      checks: [
        { kind: 'command', name: 'targeted-test', passed: true, evidence: 'ok' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(v2.schemaVersion, 2);
    assert.equal(v2.revision, 0);
    assert.equal(v2.checks[0]?.revision, 0);
    assert.equal(v2.signals.length, 0);
    assert.equal(v2.gates.length, 0);
    assert.equal(v2.waivers.length, 0);
    assert.ok(v2.baseline);
  });
});

describe('latestRunFromEntries migrates v1', () => {
  it('auto-migrates legacy session entries', () => {
    const found = latestRunFromEntries([
      {
        type: 'custom',
        customType: 'skeg/run',
        data: {
          id: 'run_legacy',
          intent: 'legacy',
          status: 'active',
          risk: 'lean',
          riskSource: 'advisory',
          phase: 'orient',
          changedFiles: [],
          checks: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    assert.equal(found?.schemaVersion, 2);
    assert.equal(found?.intent, 'legacy');
    assert.equal(migrateRunState(found)?.schemaVersion, 2);
  });
});
