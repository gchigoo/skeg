import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { buildInjectContext, estimateTokens } from './inject.ts';
import { createRecord } from './record.ts';
import { createRun, upsertCheck } from './run.ts';
import type { SkegConfig } from './types.ts';

describe('buildInjectContext', () => {
  it('stays under 800 tokens for a typical run', () => {
    const run = createRun('fix logout avatar cache after sign out');
    run.changedFiles = ['src/auth/logout.ts', 'src/auth/logout.test.ts'];
    const text = buildInjectContext(run, DEFAULT_CONFIG, process.cwd());
    assert.ok(estimateTokens(text) <= 800, `tokens=${estimateTokens(text)}`);
  });

  it('standard includes Rules and phase Next hint', () => {
    const run = createRun('add filter chip');
    run.phase = 'prove';
    const text = buildInjectContext(run, DEFAULT_CONFIG, process.cwd());
    assert.match(text, /Rules:/);
    assert.match(text, /Next:/);
  });

  it('compact omits Rules, Project, and Next hint', () => {
    const config: SkegConfig = { ...DEFAULT_CONFIG, guidance: 'compact' };
    const run = createRun('add filter chip');
    run.phase = 'prove';
    run.changedFiles = ['src/orders/List.tsx'];
    const text = buildInjectContext(run, config, process.cwd());
    assert.doesNotMatch(text, /Rules:/);
    assert.doesNotMatch(text, /^Project:/m);
    assert.doesNotMatch(text, /Next:/);
    assert.match(text, /Intent:/);
    assert.match(text, /Checks due:/);
    assert.ok(estimateTokens(text) <= 800);
  });

  it('compact and standard both stay under budget after checks', () => {
    let run = createRun('prove with many checks');
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
      evidence: 'pnpm test src/a.test.ts → ok',
    });
    run = upsertCheck(run, {
      kind: 'diff',
      name: 'diff',
      passed: true,
      evidence: '2 file(s)',
    });
    for (const guidance of ['compact', 'standard'] as const) {
      const config: SkegConfig = { ...DEFAULT_CONFIG, guidance };
      const text = buildInjectContext(run, config, process.cwd());
      assert.ok(
        estimateTokens(text) <= 800,
        `${guidance} tokens=${estimateTokens(text)}`,
      );
    }
  });

  it('standard injects records index when present', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-inject-rec-'));
    try {
      createRecord(cwd, {
        type: 'decision',
        title: 'Auth boundary clears session on logout',
      });
      const run = createRun('fix session clear');
      const text = buildInjectContext(run, DEFAULT_CONFIG, cwd);
      assert.match(text, /Records \(\.skeg\/records\/\):/);
      assert.match(text, /DEC-001 Auth boundary clears session on logout/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('compact omits records index', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-inject-compact-'));
    try {
      createRecord(cwd, {
        type: 'decision',
        title: 'Auth boundary clears session on logout',
      });
      const config: SkegConfig = { ...DEFAULT_CONFIG, guidance: 'compact' };
      const run = createRun('fix session clear');
      const text = buildInjectContext(run, config, cwd);
      assert.doesNotMatch(text, /Records/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('omits Records when no records exist', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-inject-none-'));
    try {
      const run = createRun('fix session clear');
      const text = buildInjectContext(run, DEFAULT_CONFIG, cwd);
      assert.doesNotMatch(text, /Records/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
