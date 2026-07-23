/**
 * Evidence Report V1 schema 冻结断言。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { buildRunContract } from './contract.ts';
import { reduce } from './reducer.ts';
import { buildEvidenceReportV1 } from './report.ts';

const REQUIRED_KEYS = [
  'schemaVersion',
  'runId',
  'intent',
  'status',
  'phase',
  'revision',
  'risk',
  'contractHash',
  'changedFiles',
  'checks',
  'signals',
  'gates',
  'waivers',
  'generatedAt',
] as const;

describe('buildEvidenceReportV1', () => {
  it('emits null run shape when idle', () => {
    const report = buildEvidenceReportV1(null, DEFAULT_CONFIG, '2026-01-01T00:00:00.000Z');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.runId, null);
    assert.deepEqual(report.changedFiles, []);
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in report, key);
    }
  });

  it('includes contract hash and checks for active run', () => {
    const contract = buildRunContract(DEFAULT_CONFIG, '2026-01-01T00:00:00.000Z');
    let run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'report me',
      risk: 'lean',
      contract,
    });
    run = reduce(run, {
      type: 'CHECK_RECORDED',
      check: { kind: 'diff', name: 'diff', passed: true },
    });
    const report = buildEvidenceReportV1(run, DEFAULT_CONFIG, '2026-01-01T01:00:00.000Z');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.runId, run.id);
    assert.equal(report.intent, 'report me');
    assert.equal(report.contractHash, contract.configHash);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]?.name, 'diff');
    assert.deepEqual(Object.keys(report).sort(), [...REQUIRED_KEYS].sort());
  });
});
