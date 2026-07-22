import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyBashEffect } from './effects.ts';

describe('classifyBashEffect', () => {
  it('classifies cat as read', () => {
    assert.equal(classifyBashEffect('cat migrations/001.sql').kind, 'read');
  });

  it('classifies pnpm add as dependency-mutation', () => {
    const e = classifyBashEffect('pnpm add zod');
    assert.equal(e.kind, 'dependency-mutation');
    if (e.kind === 'dependency-mutation') {
      assert.ok(e.paths.includes('package.json'));
    }
  });

  it('classifies redirects as file-mutation', () => {
    assert.equal(classifyBashEffect('echo hi > out.txt').kind, 'file-mutation');
  });

  it('classifies rm -rf as destructive', () => {
    assert.equal(classifyBashEffect('rm -rf /tmp/x').kind, 'destructive');
  });

  it('classifies prisma migrate as migration-execution', () => {
    assert.equal(
      classifyBashEffect('prisma migrate deploy').kind,
      'migration-execution',
    );
  });
});
