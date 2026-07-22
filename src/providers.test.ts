/**
 * Provider 加载与合并行为。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import {
  classifyWithProviders,
  loadProviders,
  mergePolicyHits,
  resolveProviderSpec,
} from './providers.ts';
import type { RiskHit } from './types.ts';

describe('resolveProviderSpec', () => {
  it('resolves relative paths to file URLs', () => {
    const url = resolveProviderSpec('/proj', './providers/foo.mjs');
    assert.match(url, /^file:/);
    assert.match(url, /foo\.mjs$/);
  });

  it('keeps bare package names', () => {
    assert.equal(resolveProviderSpec('/proj', '@acme/skeg-policy'), '@acme/skeg-policy');
  });
});

describe('loadProviders', () => {
  it('loads a module and reports missing module as diagnostic', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-prov-'));
    try {
      writeFileSync(
        join(cwd, 'ok-provider.mjs'),
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
      if (command.includes('cargo test')) return { kind: 'command', name: 'test' };
      return null;
    }
  }
};
`,
        'utf8',
      );
      const ok = await loadProviders(cwd, {
        ...DEFAULT_CONFIG,
        providers: ['./ok-provider.mjs'],
      });
      assert.equal(ok.policies.length, 1);
      assert.equal(ok.checks.length, 1);
      assert.equal(ok.diagnostics.length, 0);

      const missing = await loadProviders(cwd, {
        ...DEFAULT_CONFIG,
        providers: ['./missing-provider.mjs'],
      });
      assert.equal(missing.policies.length, 0);
      assert.ok(missing.diagnostics.some((d) => d.level === 'error'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
          inspect: (action) =>
            action.paths.map((path) => ({
              trigger: 'databaseMigration' as const,
              strength: 'deterministic' as const,
              path,
              reason: 'extra',
            })),
        },
      ],
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].trigger, 'protectedPaths');
    assert.equal(merged[1].trigger, 'databaseMigration');
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
          classify: () => ({ kind: 'command', name: 'test' }),
        },
      ],
    );
    assert.deepEqual(hit, { kind: 'command', name: 'targeted-test' });
  });

  it('uses provider when builtin is null', () => {
    const hit = classifyWithProviders('cargo test', DEFAULT_CONFIG, null, [
      {
        classify: (command) =>
          command.includes('cargo test')
            ? { kind: 'command', name: 'test' }
            : null,
      },
    ]);
    assert.deepEqual(hit, { kind: 'command', name: 'test' });
  });
});
