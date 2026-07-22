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
  requiredPolicyUnavailable,
  selectRecordsWithProviders,
} from './providers.ts';
import { trustProvider } from './trust.ts';
import type { ProviderConfigEntry, RiskHit } from './types.ts';

function entry(
  spec: string,
  opts: Partial<ProviderConfigEntry> = {},
): ProviderConfigEntry {
  return {
    id: opts.id ?? spec,
    spec,
    required: opts.required ?? false,
    priority: opts.priority ?? 0,
  };
}

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
      providers: [entry('.skeg/providers/evil.mjs')],
    });
    assert.equal(loaded.checks.length, 0);
    assert.ok(loaded.diagnostics.some((d) => d.message.includes('not trusted')));
    assert.equal(existsSync(marker), false);
  });

  it('loads a trusted V1 module', async () => {
    writeFileSync(
      join(cwd, '.skeg', 'providers', 'ok.mjs'),
      `export default {
  apiVersion: 1,
  id: 'special',
  capabilities: ['policy', 'check'],
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
      providers: [entry(spec, { id: 'special' })],
    });
    assert.equal(ok.policies.length, 1);
    assert.equal(ok.checks.length, 1);
    assert.equal(ok.policies[0].id, 'special');
    assert.equal(ok.diagnostics.filter((d) => d.level === 'error').length, 0);
  });

  it('records requiredPolicyFailures when required provider untrusted', async () => {
    writeFileSync(
      join(cwd, '.skeg', 'providers', 'req.mjs'),
      `export default {
  apiVersion: 1,
  id: 'req',
  capabilities: ['policy'],
  policies: { inspect() { return []; } }
};
`,
      'utf8',
    );
    const loaded = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: [entry('.skeg/providers/req.mjs', { id: 'req', required: true })],
    });
    assert.ok(loaded.requiredPolicyFailures.length >= 1);
    assert.ok(
      requiredPolicyUnavailable(loaded)?.includes('required provider'),
    );
  });

  it('rejects providers outside .skeg/providers', async () => {
    writeFileSync(join(cwd, 'outside.mjs'), 'export default {};\n', 'utf8');
    const loaded = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: [entry('./outside.mjs')],
    });
    assert.equal(loaded.checks.length, 0);
    assert.ok(
      loaded.diagnostics.some((d) => d.message.includes('.skeg/providers')),
    );
  });

  it('rejects legacy modules without apiVersion', async () => {
    writeFileSync(
      join(cwd, '.skeg', 'providers', 'legacy.mjs'),
      `export default {
  checks: { classify() { return { kind: 'command', name: 'legacy-check' }; } }
};
`,
      'utf8',
    );
    const spec = '.skeg/providers/legacy.mjs';
    assert.equal(trustProvider(cwd, spec).ok, true);
    const loaded = await loadProviders(cwd, {
      ...DEFAULT_CONFIG,
      providers: [entry(spec, { id: 'legacy' })],
    });
    assert.equal(loaded.checks.length, 0);
    assert.ok(
      loaded.diagnostics.some(
        (d) =>
          d.level === 'error' &&
          /apiVersion:\s*1|defineProvider|legacy/i.test(d.message),
      ),
    );
  });
});

describe('mergePolicyHits', () => {
  it('appends provider hits with provenance and dedupes', () => {
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
          id: 'sql',
          spec: 'sql',
          required: false,
          priority: 10,
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
        {
          id: 'sql-dup',
          spec: 'sql-dup',
          required: false,
          priority: 5,
          impl: {
            inspect: () => [
              {
                trigger: 'databaseMigration' as const,
                strength: 'deterministic' as const,
                path: 'm.sql',
                reason: 'dup',
              },
            ],
          },
        },
      ],
    );
    assert.equal(merged.hits.length, 2);
    assert.equal(merged.hits[0].source, 'builtin');
    assert.equal(merged.hits[1].source, 'provider:sql');
  });

  it('rejects malformed RiskHits', () => {
    const merged = mergePolicyHits(
      [],
      { toolName: 'write', input: {}, paths: [] },
      DEFAULT_CONFIG,
      [
        {
          id: 'bad',
          spec: 'bad',
          required: false,
          priority: 0,
          impl: {
            inspect: () =>
              [{ trigger: 'not-a-trigger', reason: 'x' }] as unknown as RiskHit[],
          },
        },
      ],
    );
    assert.equal(merged.hits.length, 0);
    assert.ok(merged.diagnostics.some((d) => d.message.includes('invalid trigger')));
  });

  it('surfaces policy provider errors with required flag', () => {
    const merged = mergePolicyHits(
      [],
      { toolName: 'write', input: {}, paths: [] },
      DEFAULT_CONFIG,
      [
        {
          id: 'broken',
          spec: 'broken',
          required: true,
          priority: 0,
          impl: {
            inspect: () => {
              throw new Error('boom');
            },
          },
        },
      ],
    );
    assert.equal(merged.errors.length, 1);
    assert.equal(merged.errors[0].required, true);
    assert.ok(
      requiredPolicyUnavailable(
        {
          policies: [],
          checks: [],
          records: [],
          diagnostics: [],
          configHash: '',
          entries: [],
          requiredPolicyFailures: [],
        },
        new Set(),
        merged.errors,
      ),
    );
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
          id: 'p',
          spec: 'p',
          required: false,
          priority: 0,
          impl: { classify: () => ({ kind: 'command', name: 'test' }) },
        },
      ],
    );
    assert.deepEqual(hit.check, {
      kind: 'command',
      name: 'targeted-test',
      source: 'builtin',
    });
  });

  it('uses higher priority provider and reports conflicts', () => {
    const hit = classifyWithProviders(
      'just skeg-special-verify',
      DEFAULT_CONFIG,
      null,
      [
        {
          id: 'a',
          spec: 'a',
          required: false,
          priority: 10,
          impl: {
            classify: () => ({ kind: 'command', name: 'special-a' }),
          },
        },
        {
          id: 'b',
          spec: 'b',
          required: false,
          priority: 10,
          impl: {
            classify: () => ({ kind: 'command', name: 'special-b' }),
          },
        },
      ],
    );
    assert.equal(hit.check?.name, 'special-a');
    assert.equal(hit.check?.source, 'provider:a');
    assert.ok(hit.diagnostics.some((d) => d.message.includes('conflict')));
  });
});

describe('selectRecordsWithProviders', () => {
  it('does not let empty array replace fallback', () => {
    const selected = selectRecordsWithProviders(
      { cwd: '/tmp', intent: 'x', changedFiles: [] },
      [
        {
          id: 'empty',
          spec: 'empty',
          required: false,
          priority: 0,
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

  it('augments without clearing fallback', () => {
    const selected = selectRecordsWithProviders(
      { cwd: '/tmp', intent: 'x', changedFiles: [] },
      [
        {
          id: 'aug',
          spec: 'aug',
          required: false,
          priority: 0,
          impl: {
            select: () => ({
              mode: 'augment' as const,
              records: [
                {
                  id: 'r2',
                  type: 'decision' as const,
                  title: 'extra',
                  fileName: 'y.md',
                  createdAt: '',
                },
              ],
            }),
          },
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
    assert.equal(selected.records.length, 2);
    assert.ok(selected.records.some((r) => r.id === 'r1'));
    assert.ok(selected.records.some((r) => r.id === 'r2'));
  });
});
