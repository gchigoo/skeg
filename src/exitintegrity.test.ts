/**
 * Shell 退出码完整性检测（含嵌套 wrapper）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commandForCheckClassification,
  inspectExitIntegrity,
  unwrapShellWrapper,
} from './exitintegrity.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { classifyCheckCommand } from './checks.ts';

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

  it('ignores operators inside quotes on standalone commands', () => {
    assert.equal(
      inspectExitIntegrity('pnpm test --reporter="a|b"'),
      'preserved',
    );
  });
});

describe('NestedShellFalseEvidence', () => {
  it('unwraps bash -c and masks || true in payload', () => {
    const cmd = "bash -c 'pnpm test src/foo.test.ts || true'";
    const wrapper = unwrapShellWrapper(cmd);
    assert.ok(wrapper);
    assert.equal(wrapper?.kind, 'posix');
    assert.equal(inspectExitIntegrity(cmd), 'masked');
    assert.equal(
      classifyCheckCommand(commandForCheckClassification(cmd), DEFAULT_CONFIG)
        ?.name,
      'targeted-test',
    );
    // 外层命令本身不应被 targeted-test 命中（引号内）
    assert.equal(classifyCheckCommand(cmd, DEFAULT_CONFIG), null);
  });

  it('masks bash -c with bare test || true', () => {
    assert.equal(
      inspectExitIntegrity("bash -c 'pnpm test || true'"),
      'masked',
    );
  });

  it('masks sh -c with semicolon exit 0', () => {
    assert.equal(
      inspectExitIntegrity('sh -c "npm test; exit 0"'),
      'masked',
    );
  });

  it('masks powershell -Command masking', () => {
    assert.equal(
      inspectExitIntegrity('powershell -Command "npm test; exit 0"'),
      'masked',
    );
  });

  it('masks cmd /c with & exit /b 0', () => {
    assert.equal(
      inspectExitIntegrity('cmd /c "npm test & exit /b 0"'),
      'masked',
    );
  });

  it('preserves clean bash -c payload', () => {
    assert.equal(
      inspectExitIntegrity("bash -c 'pnpm test src/foo.test.ts'"),
      'preserved',
    );
  });
});
