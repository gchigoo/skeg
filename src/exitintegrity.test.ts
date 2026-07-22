/**
 * Shell 退出码完整性检测。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectExitIntegrity } from './exitintegrity.ts';

describe('inspectExitIntegrity', () => {
  it('accepts standalone and && chains', () => {
    assert.equal(inspectExitIntegrity('pnpm test'), 'preserved');
    assert.equal(
      inspectExitIntegrity('cd packages/api && pnpm test'),
      'preserved',
    );
    assert.equal(inspectExitIntegrity('NODE_ENV=test pnpm test'), 'preserved');
    assert.equal(
      inspectExitIntegrity('pnpm test && echo completed'),
      'preserved',
    );
  });

  it('rejects masking operators', () => {
    assert.equal(inspectExitIntegrity('pnpm test || true'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test; echo completed'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test | tee test.log'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test &'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test || echo failed'), 'masked');
    assert.equal(inspectExitIntegrity('pnpm test; exit 0'), 'masked');
  });

  it('does not treat redirections as background', () => {
    assert.equal(inspectExitIntegrity('pnpm test 2>&1'), 'preserved');
    assert.equal(inspectExitIntegrity('pnpm test >&2'), 'preserved');
  });

  it('ignores operators inside quotes', () => {
    assert.equal(
      inspectExitIntegrity('pnpm test --reporter="a|b"'),
      'preserved',
    );
  });
});
