import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import { buildCommandCheck, classifyCheckCommand } from './checks.ts';
import type { SkegConfig } from './types.ts';

describe('classifyCheckCommand', () => {
  it('classifies bare test runners as test', () => {
    for (const cmd of [
      'npm test',
      'pnpm test',
      'yarn test',
      'vitest',
      'vitest run',
      'jest',
      'pytest',
      'go test',
      'cargo test',
    ]) {
      const hit = classifyCheckCommand(cmd, DEFAULT_CONFIG);
      assert.deepEqual(hit, { kind: 'command', name: 'test' }, cmd);
    }
  });

  it('classifies path-scoped tests as targeted-test', () => {
    for (const cmd of [
      'pnpm test src/profile/load.test.ts',
      'npm test -- src/foo.test.ts',
      'vitest run src/a.test.ts',
      'jest src/auth/logout.test.ts',
      'pytest tests/test_auth.py',
      'go test ./pkg/auth',
      'node --test tests/http-client.js',
    ]) {
      const hit = classifyCheckCommand(cmd, DEFAULT_CONFIG);
      assert.deepEqual(hit, { kind: 'command', name: 'targeted-test' }, cmd);
    }
  });

  it('classifies bare node --test as test', () => {
    assert.deepEqual(classifyCheckCommand('node --test', DEFAULT_CONFIG), {
      kind: 'command',
      name: 'test',
    });
  });

  it('classifies lint / typecheck / build', () => {
    assert.deepEqual(classifyCheckCommand('pnpm lint', DEFAULT_CONFIG), {
      kind: 'command',
      name: 'lint',
    });
    assert.deepEqual(classifyCheckCommand('eslint src', DEFAULT_CONFIG), {
      kind: 'command',
      name: 'lint',
    });
    assert.deepEqual(classifyCheckCommand('pnpm typecheck', DEFAULT_CONFIG), {
      kind: 'command',
      name: 'typecheck',
    });
    assert.deepEqual(classifyCheckCommand('tsc --noEmit', DEFAULT_CONFIG), {
      kind: 'command',
      name: 'typecheck',
    });
    assert.deepEqual(classifyCheckCommand('pnpm build', DEFAULT_CONFIG), {
      kind: 'command',
      name: 'build',
    });
  });

  it('ignores non-verification commands', () => {
    for (const cmd of [
      'ls src',
      'rg -n avatar src/auth',
      'git status',
      'cat package.json',
      'pnpm why zod',
    ]) {
      assert.equal(classifyCheckCommand(cmd, DEFAULT_CONFIG), null, cmd);
    }
  });

  it('prefers config.commands over heuristics', () => {
    const config: SkegConfig = {
      ...DEFAULT_CONFIG,
      checks: {
        ...DEFAULT_CONFIG.checks,
        commands: {
          'unit-smoke': 'make smoke',
          'custom-lint': '/biome\\s+ci/i',
        },
      },
    };
    assert.deepEqual(classifyCheckCommand('make smoke', config), {
      kind: 'command',
      name: 'unit-smoke',
    });
    assert.deepEqual(classifyCheckCommand('biome ci .', config), {
      kind: 'command',
      name: 'custom-lint',
    });
  });
});

describe('buildCommandCheck', () => {
  it('records pass/fail with truncated evidence', () => {
    const ok = buildCommandCheck('test', 'npm test', true, 'ok\n');
    assert.equal(ok.kind, 'command');
    assert.equal(ok.name, 'test');
    assert.equal(ok.passed, true);
    assert.match(ok.evidence ?? '', /npm test → ok/);

    const fail = buildCommandCheck(
      'targeted-test',
      'pnpm test src/a.test.ts',
      false,
      'FAIL',
    );
    assert.equal(fail.passed, false);
    assert.match(fail.evidence ?? '', /fail/);
  });
});
