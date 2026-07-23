/**
 * 公共 DTO 与内部类型结构兼容：内部漂移时 typecheck/测试失败。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClassifiedCheck } from './checks.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type {
  ProviderActionV1,
  ProviderClassifiedCheckV1,
  ProviderConfigV1,
  ProviderRecordEntryV1,
  ProviderRiskHitV1,
} from './provider-api.ts';
import type { RecordIndexEntry } from './record.ts';
import type { RiskHit, VeritackConfig } from './types.ts';

/**
 * 编译期：内部类型可赋给公共只读 DTO。
 * @param _v 占位
 */
function assertAssignable<_T>(_v: _T): void {
  /* type-level only */
}

describe('PublicDtoDrift', () => {
  it('VeritackConfig is assignable to ProviderConfigV1', () => {
    const config: VeritackConfig = DEFAULT_CONFIG;
    const view: ProviderConfigV1 = config;
    assertAssignable<ProviderConfigV1>(view);
    assert.equal(view.defaultPolicy, config.defaultPolicy);
  });

  it('RiskHit / ClassifiedCheck / RecordIndexEntry assign to V1 DTOs', () => {
    const hit: RiskHit = {
      trigger: 'protectedPaths',
      strength: 'deterministic',
      path: '.env',
      reason: 'x',
      source: 'builtin',
    };
    const asHit: ProviderRiskHitV1 = hit;
    assertAssignable<ProviderRiskHitV1>(asHit);

    const check: ClassifiedCheck = {
      kind: 'command',
      name: 'test',
      source: 'builtin',
    };
    const asCheck: ProviderClassifiedCheckV1 = check;
    assertAssignable<ProviderClassifiedCheckV1>(asCheck);

    const rec: RecordIndexEntry = {
      id: 'DEC_1',
      type: 'decision',
      title: 't',
      createdAt: '2026-01-01T00:00:00.000Z',
      fileName: 'DEC_1.md',
    };
    const asRec: ProviderRecordEntryV1 = rec;
    assertAssignable<ProviderRecordEntryV1>(asRec);

    const action: ProviderActionV1 = {
      toolName: 'write',
      input: { path: 'a.ts' },
      paths: ['a.ts'],
    };
    assert.equal(action.toolName, 'write');
  });
});
