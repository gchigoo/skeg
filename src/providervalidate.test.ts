/**
 * Provider 输出校验。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateClassifiedCheck,
  validateRecordEntries,
  validateRiskHits,
} from './providervalidate.ts';

describe('validateRiskHits', () => {
  it('accepts valid hits and tags source', () => {
    const { hits, diagnostics } = validateRiskHits(
      [
        {
          trigger: 'databaseMigration',
          strength: 'deterministic',
          path: './m.sql',
          reason: 'sql change',
        },
      ],
      'provider:sql',
      'test',
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].source, 'provider:sql');
    assert.equal(hits[0].path, 'm.sql');
    assert.equal(diagnostics.length, 0);
  });

  it('rejects unknown triggers', () => {
    const { hits, diagnostics } = validateRiskHits(
      [{ trigger: 'nope', strength: 'weak', path: '', reason: 'x' }],
      'provider:x',
      'test',
    );
    assert.equal(hits.length, 0);
    assert.ok(diagnostics.some((d) => d.message.includes('invalid trigger')));
  });
});

describe('validateClassifiedCheck', () => {
  it('rejects invalid names', () => {
    const { check, diagnostics } = validateClassifiedCheck(
      { kind: 'command', name: 'Bad Name!' },
      'provider:x',
      'test',
    );
    assert.equal(check, null);
    assert.ok(diagnostics.length > 0);
  });
});

describe('validateRecordEntries', () => {
  it('truncates to 5', () => {
    const raw = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      type: 'decision',
      title: `t${i}`,
      fileName: `f${i}.md`,
      createdAt: '',
    }));
    const { records, diagnostics } = validateRecordEntries(raw, 'test');
    assert.equal(records.length, 5);
    assert.ok(diagnostics.some((d) => d.message.includes('truncating')));
  });
});
