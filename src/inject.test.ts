import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { buildInjectContext, estimateTokens } from './inject.ts';
import { createRun } from './run.ts';

describe('buildInjectContext', () => {
  it('stays under 800 tokens for a typical run', () => {
    const run = createRun('fix logout avatar cache after sign out');
    run.changedFiles = ['src/auth/logout.ts', 'src/auth/logout.test.ts'];
    const text = buildInjectContext(run, DEFAULT_CONFIG, process.cwd());
    assert.ok(estimateTokens(text) <= 800, `tokens=${estimateTokens(text)}`);
  });
});
