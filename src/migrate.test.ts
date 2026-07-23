import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIXTURE_V1_FULL, FIXTURE_V2_FULL } from './migrate.fixtures.ts';
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

describe('MigrationRegression fixtures', () => {
  it('migrates frozen v1 fixture to schema 2 with invariants', () => {
    const migrated = migrateRunState(FIXTURE_V1_FULL);
    assert.ok(migrated);
    assert.equal(migrated!.schemaVersion, 2);
    assert.equal(migrated!.revision, 0);
    assert.equal(migrated!.intent, FIXTURE_V1_FULL.intent);
    assert.equal(migrated!.checks.length, FIXTURE_V1_FULL.checks.length);
    assert.ok(migrated!.checks.every((c) => c.revision === 0));
    assert.ok(migrated!.baseline?.capturedAt);
    assert.ok(migrated!.pendingGate);
    assert.equal(migrated!.pendingGate?.trigger, 'databaseMigration');
    assert.deepEqual(migrated!.recordIds, FIXTURE_V1_FULL.recordIds);
    assert.equal(migrated!.signals.length, 0);
    assert.ok(migrated!.gates.length >= 1);
  });

  it('preserves frozen v2 fixture including contract', () => {
    const migrated = migrateRunState(FIXTURE_V2_FULL);
    assert.ok(migrated);
    assert.equal(migrated!.schemaVersion, 2);
    assert.equal(migrated!.revision, FIXTURE_V2_FULL.revision);
    assert.equal(migrated!.intent, FIXTURE_V2_FULL.intent);
    assert.equal(migrated!.checks.length, 1);
    assert.equal(migrated!.signals.length, 1);
    assert.equal(migrated!.gates.length, 1);
    assert.equal(migrated!.waivers.length, 1);
    assert.ok(migrated!.baseline?.head);
    assert.equal(migrated!.observation?.hash, 'deadbeef');
    assert.deepEqual(migrated!.contract, FIXTURE_V2_FULL.contract);
    assert.deepEqual(migrated!.recordIds, FIXTURE_V2_FULL.recordIds);
  });
});
