/**
 * RunContract：冻结验证契约与配置弱化防护。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateClosure } from './closure.ts';
import { DEFAULT_CONFIG } from './config.ts';
import {
  buildRunContract,
  configContractHash,
  hasContractDrift,
  requiredChecksFromContract,
} from './contract.ts';
import { reduce } from './reducer.ts';
import { createRun, upsertCheck } from './run.ts';
import type { VeritackConfig } from './types.ts';

describe('buildRunContract', () => {
  it('snapshots checks and hashes', () => {
    const contract = buildRunContract(DEFAULT_CONFIG, '2026-01-01T00:00:00.000Z');
    assert.equal(contract.schemaVersion, 1);
    assert.deepEqual(contract.defaultChecks, DEFAULT_CONFIG.checks.default);
    assert.deepEqual(contract.guardedChecks, DEFAULT_CONFIG.checks.guarded);
    assert.equal(contract.configHash, configContractHash(DEFAULT_CONFIG));
    assert.equal(contract.createdAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('ConfigDriftBypass', () => {
  it('finish still requires original guarded contract after config weaken', () => {
    const startConfig: VeritackConfig = {
      ...DEFAULT_CONFIG,
      defaultPolicy: 'guarded',
      checks: {
        default: ['targeted-test', 'diff'],
        guarded: ['test', 'typecheck', 'lint', 'diff'],
      },
    };
    let run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'harden',
      risk: 'guarded',
      contract: buildRunContract(startConfig),
    });

    // 运行中弱化配置：只剩 diff
    const weakened: VeritackConfig = {
      ...startConfig,
      checks: {
        default: ['diff'],
        guarded: ['diff'],
      },
    };
    assert.equal(hasContractDrift(run, weakened), true);
    assert.deepEqual(
      requiredChecksFromContract(run, weakened),
      ['test', 'typecheck', 'lint', 'diff'],
    );

    run = upsertCheck(run, { kind: 'diff', name: 'diff', passed: true });
    const ev = evaluateClosure(run, weakened);
    assert.equal(ev.ok, false);
    assert.ok(ev.missing.includes('test'));
    assert.ok(ev.missing.includes('typecheck'));
    assert.ok(ev.missing.includes('lint'));
  });

  it('falls back to live config when contract missing (legacy session)', () => {
    const run = createRun('legacy');
    assert.equal(run.contract, undefined);
    assert.deepEqual(
      requiredChecksFromContract(run, DEFAULT_CONFIG),
      DEFAULT_CONFIG.checks.default,
    );
  });
});
