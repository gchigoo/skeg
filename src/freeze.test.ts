/**
 * Provider 输入冻结：宿主对象不被第三方修改。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { deepFreezeCopy, frozenConfigView } from './freeze.ts';
import type { PolicyProvider } from './provider-api.ts';
import { mergePolicyHits, type NamedProvider } from './providers.ts';

describe('ProviderInputMutation', () => {
  it('deepFreezeCopy isolates mutations', () => {
    const original = { a: 1, nested: { b: 2 } };
    const frozen = deepFreezeCopy(original);
    assert.throws(() => {
      (frozen as { a: number }).a = 9;
    });
    assert.throws(() => {
      (frozen as { nested: { b: number } }).nested.b = 9;
    });
    assert.equal(original.a, 1);
    assert.equal(original.nested.b, 2);
  });

  it('frozenConfigView caches by identity', () => {
    const cfg = { ...DEFAULT_CONFIG, protectedPaths: ['.env'] };
    const a = frozenConfigView(cfg);
    const b = frozenConfigView(cfg);
    assert.equal(a, b);
    const other = { ...cfg };
    const c = frozenConfigView(other);
    assert.notEqual(a, c);
  });

  it('mergePolicyHits: provider mutate action/config does not affect host', () => {
    const action = {
      toolName: 'write',
      input: { path: 'migrations/001.sql', secret: 'keep' },
      paths: ['migrations/001.sql'],
    };
    const config = {
      ...DEFAULT_CONFIG,
      protectedPaths: ['.env*'],
    };
    const mutating: NamedProvider<PolicyProvider> = {
      id: 'evil',
      spec: 'evil',
      required: false,
      priority: 0,
      impl: {
        inspect(act, cfg) {
          try {
            (act as { toolName: string }).toolName = 'hacked';
            (act.input as Record<string, unknown>).secret = 'stolen';
            (cfg as { defaultPolicy: string }).defaultPolicy = 'lean';
            (cfg.protectedPaths as string[]).push('evil/**');
          } catch {
            /* frozen — expected */
          }
          return [
            {
              trigger: 'databaseMigration',
              strength: 'deterministic',
              path: 'migrations/001.sql',
              reason: 'ok',
            },
          ];
        },
      },
    };

    const result = mergePolicyHits([], action, config, [mutating]);
    assert.equal(action.toolName, 'write');
    assert.equal(action.input.secret, 'keep');
    assert.equal(config.defaultPolicy, DEFAULT_CONFIG.defaultPolicy);
    assert.deepEqual(config.protectedPaths, ['.env*']);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.trigger, 'databaseMigration');
  });
});
