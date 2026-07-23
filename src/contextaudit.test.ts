/**
 * Context 审计：默认摘要 / full 含 content。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildContextAuditPayload } from './contextaudit.ts';

describe('AuditDefaultDigest', () => {
  it('omits content by default', () => {
    const p = buildContextAuditPayload('hello skeg', 'abc123', undefined);
    assert.equal(p.hash, 'abc123');
    assert.ok(p.tokens > 0);
    assert.equal('content' in p, false);
  });

  it('includes content when SKEG_CONTEXT_AUDIT=full', () => {
    const p = buildContextAuditPayload('hello skeg', 'abc123', 'full');
    assert.equal(p.content, 'hello skeg');
    assert.equal(p.hash, 'abc123');
  });
});
