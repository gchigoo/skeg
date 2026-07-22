/**
 * Provider 加载与合并行为。
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import {
  classifyWithProviders,
  loadProviders,
  mergePolicyHits,
  selectRecordsWithProviders,
} from './providers.ts';
import { trustProvider } from './trust.ts';
import type { RiskHit } from './types.ts';

describe('loadProviders', () => {
  let userDir = '';
  let cwd = '';
  let prevUserDir: string | undefined;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'skeg-prov-user-'));
    cwd = mkdtempSync(join(tmpdir(), 'skeg-prov-cwd-'));
    prevUserDir = process.env.SKEG_USER_DIR;
    process.env.SKEG_USER_DIR = userDir;
    mkdirSync(join(cwd, '.skeg', 'providers'), { recursive: true });
  });

  afterEach(() => {
    if (prevUserDir === undefined) delete process.env.SKEG_USER_DIR;
    else process.env.SKEG_USER_DIR = prevUserDir;
    rmSync(userDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not import untrusted providers', async () => {
    const marker = join(cwd, 'side-effect.txt');
    writeFileSync(
      join(cwd, '.skeg', 'providers', 'evil.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export default { checks: { classify() { return null; } } };
`,
      'utf8',
    );
    const loaded = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: ['.skeg/providers/evil.mjs'],
    });
    assert.equal(loaded.checks.length, 0);
    assert.ok(loaded.diagnostics.some((d) => d.message.includes('not trusted')));
    assert.equal(existsSync(marker), false);
  });

  it('loads a trusted module and reports missing module as diagnostic', async () => {
    writeFileSync(
      join(cwd, '.skeg', 'providers', 'ok.mjs'),
      `export default {
  policies: {
    inspect(action) {
      if (action.paths.some((p) => p.endsWith('.sql'))) {
        return [{
          trigger: 'databaseMigration',
          strength: 'deterministic',
          path: action.paths[0],
          reason: 'provider sql',
        }];
      }
      return [];
    }
  },
  checks: {
    classify(command) {
      if (command === 'just skeg-special-verify') {
        return { kind: 'command', name: 'special-verify' };
      }
      return null;
    }
  }
};
`,
      'utf8',
    );
    const spec = '.skeg/providers/ok.mjs';
    assert.equal(trustProvider(cwd, spec).ok, true);

    const ok = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: [spec],
    });
    assert.equal(ok.policies.length, 1);
    assert.equal(ok.checks.length, 1);
    assert.equal(ok.diagnostics.length, 0);

    const missing = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: ['.skeg/providers/missing.mjs'],
    });
    assert.equal(missing.policies.length, 0);
    assert.ok(missing.diagnostics.some((d) => d.level === 'warning' || d.level === 'error'));
  });

  it('rejects providers outside .skeg/providers', async () => {
    writeFileSync(join(cwd, 'outside.mjs'), 'export default {};\n', 'utf8');
    const loaded = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: ['./outside.mjs'],
    });
    assert.equal(loaded.checks.length, 0);
    assert.ok(
      loaded.diagnostics.some((d) =>
        d.message.includes('.skeg/providers'),
      ),
    );
  });
});

describe('mergePolicyHits', () => {
  it('appends provider hits without removing builtin', () => {
    const builtin: RiskHit[] = [
      {
        trigger: 'protectedPaths',
        strength: 'deterministic',
        path: '.env',
        reason: 'builtin',
      },
    ];
    const merged = mergePolicyHits(
      builtin,
      { toolName: 'write', input: {}, paths: ['m.sql'] },
      DEFAULT_CONFIG,
      [
        {
          spec: 'test-policy',
          impl: {
            inspect: (action) =>
              action.paths.map((path) => ({
                trigger: 'databaseMigration' as const,
                strength: 'deterministic' as const,
                path,
                reason: 'extra',
              })),
          },
        },
      ],
    );
    assert.equal(merged.hits.length, 2);
    assert.equal(merged.hits[0].trigger, 'protectedPaths');
    assert.equal(merged.hits[1].trigger, 'databaseMigration');
    assert.equal(merged.errors.length, 0);
  });

  it('surfaces policy provider errors', () => {
    const merged = mergePolicyHits(
      [],
      { toolName: 'write', input: {}, paths: [] },
      DEFAULT_CONFIG,
      [
        {
          spec: 'broken',
          impl: {
            inspect: () => {
              throw new Error('boom');
            },
          },
        },
      ],
    );
    assert.equal(merged.hits.length, 0);
    assert.equal(merged.errors.length, 1);
    assert.equal(merged.errors[0].spec, 'broken');
  });
});

describe('classifyWithProviders', () => {
  it('keeps builtin classification over provider', () => {
    const hit = classifyWithProviders(
      'pnpm test src/a.test.ts',
      DEFAULT_CONFIG,
      { kind: 'command', name: 'targeted-test' },
      [
        {
          spec: 'p',
          impl: { classify: () => ({ kind: 'command', name: 'test' }) },
        },
      ],
    );
    assert.deepEqual(hit.check, { kind: 'command', name: 'targeted-test' });
  });

  it('uses provider when builtin is null', () => {
    const hit = classifyWithProviders(
      'just skeg-special-verify',
      DEFAULT_CONFIG,
      null,
      [
        {
          spec: 'special',
          impl: {
            classify: (command) =>
              command === 'just skeg-special-verify'
                ? { kind: 'command', name: 'special-verify' }
                : null,
          },
        },
      ],
    );
    assert.deepEqual(hit.check, {
      kind: 'command',
      name: 'special-verify',
    });
  });
});

describe('selectRecordsWithProviders', () => {
  it('does not let empty array replace fallback', () => {
    const selected = selectRecordsWithProviders(
      { cwd: '/tmp', intent: 'x', changedFiles: [] },
      [
        {
          spec: 'empty',
          impl: { select: () => [] },
        },
      ],
      () => [
        {
          id: 'r1',
          type: 'decision',
          title: 'fallback',
          fileName: 'x.md',
          createdAt: '',
        },
      ],
    );
    assert.equal(selected.records.length, 1);
    assert.equal(selected.records[0].id, 'r1');
  });
});
