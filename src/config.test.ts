/**
 * config 解析单测：matcher 收紧与诊断。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfigWithDiagnostics } from './config.ts';

describe('parseCommands (via loadConfigWithDiagnostics)', () => {
  it('rejects plain substring matchers with error and ignores them', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-cfg-match-'));
    try {
      mkdirSync(join(cwd, '.skeg'), { recursive: true });
      writeFileSync(
        join(cwd, '.skeg/config.json'),
        JSON.stringify({
          checks: {
            commands: {
              'unit-smoke': 'make smoke',
              'custom-lint': '/biome\\s+ci/i',
              'pkg-test': { kind: 'package-script', script: 'test' },
            },
          },
        }),
        'utf8',
      );
      const result = loadConfigWithDiagnostics(cwd);
      assert.ok(
        result.diagnostics.some(
          (d) =>
            d.level === 'error' &&
            d.path === 'checks.commands.unit-smoke' &&
            /not allowed|Plain substring/i.test(d.message),
        ),
      );
      assert.equal(result.config.checks.commands?.['unit-smoke'], undefined);
      assert.equal(result.config.checks.commands?.['custom-lint'], '/biome\\s+ci/i');
      assert.deepEqual(result.config.checks.commands?.['pkg-test'], {
        kind: 'package-script',
        script: 'test',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('controlPlane policy', () => {
  it('ignores user override of policies.controlPlane', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-cfg-cp-'));
    try {
      mkdirSync(join(cwd, '.skeg'), { recursive: true });
      writeFileSync(
        join(cwd, '.skeg/config.json'),
        JSON.stringify({
          policies: {
            controlPlane: { risk: 'lean', action: 'ignore' },
          },
        }),
        'utf8',
      );
      const result = loadConfigWithDiagnostics(cwd);
      assert.equal(result.config.policies.controlPlane.action, 'confirm');
      assert.ok(
        result.diagnostics.some(
          (d) =>
            d.path === 'policies.controlPlane' &&
            /hard-coded|ignored/i.test(d.message),
        ),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('riskTriggers (via loadConfigWithDiagnostics)', () => {
  it('warns and does not map riskTriggers in v1.0', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-cfg-rt-'));
    try {
      mkdirSync(join(cwd, '.skeg'), { recursive: true });
      writeFileSync(
        join(cwd, '.skeg/config.json'),
        JSON.stringify({
          riskTriggers: { databaseMigration: 'lean' },
          policies: {
            databaseMigration: { risk: 'guarded', action: 'confirm' },
          },
        }),
        'utf8',
      );
      const result = loadConfigWithDiagnostics(cwd);
      assert.ok(
        result.diagnostics.some(
          (d) =>
            d.level === 'warning' &&
            d.path === 'riskTriggers' &&
            /removed in v1\.0/i.test(d.message),
        ),
      );
      assert.equal(result.config.policies.databaseMigration.risk, 'guarded');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
