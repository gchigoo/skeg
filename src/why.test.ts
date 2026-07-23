/**
 * status --why：可验证解释断言。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { buildRunContract, configContractHash } from './contract.ts';
import { reduce } from './reducer.ts';
import { applyRiskHit, upsertCheck } from './run.ts';
import type { VeritackConfig } from './types.ts';
import { buildWhyReport } from './why.ts';

describe('WhyExplainable', () => {
  it('explains guarded risk from gate with trigger', () => {
    const contract = buildRunContract(DEFAULT_CONFIG);
    let run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'migrate',
      risk: 'lean',
      contract,
    });
    run = applyRiskHit(run, {
      trigger: 'databaseMigration',
      strength: 'deterministic',
      path: 'migrations/1.sql',
      reason: 'migration path write',
      source: 'builtin',
    });
    const text = buildWhyReport(run, DEFAULT_CONFIG);
    assert.match(text, /Risk is guarded \(deterministic\)/);
    assert.match(text, /gate databaseMigration/);
    assert.match(text, /migration path write/);
    assert.match(text, /source: builtin/);
  });

  it('explains stale check with revision numbers', () => {
    const contract = buildRunContract(DEFAULT_CONFIG);
    let run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'edit',
      risk: 'lean',
      contract,
    });
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
      source: 'builtin',
    });
    run = reduce(run, {
      type: 'MUTATION_COMMITTED',
      paths: ['src/a.ts'],
    });
    const text = buildWhyReport(run, DEFAULT_CONFIG);
    assert.match(text, /targeted-test/);
    assert.match(text, /stale: passed@r0, current r1/);
    assert.match(text, /contract\.defaultChecks/);
  });

  it('explains contract drift with hash prefix and check diffs', () => {
    const start: VeritackConfig = {
      ...DEFAULT_CONFIG,
      defaultPolicy: 'guarded',
      checks: {
        default: ['targeted-test', 'diff'],
        guarded: ['test', 'typecheck', 'lint', 'diff'],
      },
    };
    const contract = buildRunContract(start);
    const run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'harden',
      risk: 'guarded',
      contract,
    });
    const weakened: VeritackConfig = {
      ...start,
      checks: { default: ['diff'], guarded: ['diff'] },
    };
    const text = buildWhyReport(run, weakened);
    assert.match(text, /Drift detected/);
    assert.match(
      text,
      new RegExp(`run\\.configHash=${contract.configHash.slice(0, 12)}`),
    );
    assert.match(
      text,
      new RegExp(`live=${configContractHash(weakened).slice(0, 12)}`),
    );
    assert.match(text, /guardedChecks:.*-test/);
    assert.match(text, /typecheck/);
  });

  it('idle run message', () => {
    assert.match(buildWhyReport(null, DEFAULT_CONFIG), /No active Veritack run/);
  });
});
