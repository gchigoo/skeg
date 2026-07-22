/**
 * Provider trust 存储与路径边界。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  checkProviderTrust,
  classifyProviderSpec,
  hashProviderContent,
  trustProvider,
  untrustProvider,
} from './trust.ts';

describe('classifyProviderSpec', () => {
  it('allows .skeg/providers relative paths', () => {
    const ok = classifyProviderSpec('.skeg/providers/foo.mjs');
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.kind, 'workspace-file');
      assert.equal(ok.relative, '.skeg/providers/foo.mjs');
    }
  });

  it('allows bare and scoped package names', () => {
    assert.equal(classifyProviderSpec('skeg-postgres').ok, true);
    assert.equal(classifyProviderSpec('@acme/skeg-policy').ok, true);
  });

  it('rejects absolute, parent, and URL specs', () => {
    assert.equal(classifyProviderSpec('/abs/evil.mjs').ok, false);
    assert.equal(classifyProviderSpec('C:\\evil.mjs').ok, false);
    assert.equal(classifyProviderSpec('../evil.mjs').ok, false);
    assert.equal(classifyProviderSpec('./providers/foo.mjs').ok, false);
    assert.equal(classifyProviderSpec('file:///tmp/x.mjs').ok, false);
  });
});

describe('trustProvider', () => {
  let userDir = '';
  let cwd = '';
  let prevUserDir: string | undefined;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'skeg-trust-user-'));
    cwd = mkdtempSync(join(tmpdir(), 'skeg-trust-cwd-'));
    prevUserDir = process.env.SKEG_USER_DIR;
    process.env.SKEG_USER_DIR = userDir;
    mkdirSync(join(cwd, '.skeg', 'providers'), { recursive: true });
    writeFileSync(
      join(cwd, '.skeg', 'providers', 'special.mjs'),
      'export default { checks: { classify() { return null; } } };\n',
      'utf8',
    );
  });

  afterEach(() => {
    if (prevUserDir === undefined) delete process.env.SKEG_USER_DIR;
    else process.env.SKEG_USER_DIR = prevUserDir;
    rmSync(userDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('requires explicit trust and binds content hash', () => {
    const spec = '.skeg/providers/special.mjs';
    const before = checkProviderTrust(cwd, spec);
    assert.equal(before.trusted, false);

    const trusted = trustProvider(cwd, spec);
    assert.equal(trusted.ok, true);
    const after = checkProviderTrust(cwd, spec);
    assert.equal(after.trusted, true);

    writeFileSync(
      join(cwd, '.skeg', 'providers', 'special.mjs'),
      'export default { checks: { classify() { return { kind: "command", name: "x" }; } } };\n',
      'utf8',
    );
    const mismatched = checkProviderTrust(cwd, spec);
    assert.equal(mismatched.trusted, false);
    if (!mismatched.trusted) {
      assert.equal(mismatched.reason, 'hash-mismatch');
    }
  });

  it('untrust removes the record', () => {
    const spec = '.skeg/providers/special.mjs';
    assert.equal(trustProvider(cwd, spec).ok, true);
    assert.equal(untrustProvider(cwd, spec).ok, true);
    assert.equal(checkProviderTrust(cwd, spec).trusted, false);
  });

  it('hashes workspace provider content', () => {
    const hashed = hashProviderContent(cwd, '.skeg/providers/special.mjs');
    assert.equal(hashed.ok, true);
    if (hashed.ok) assert.match(hashed.hash, /^[a-f0-9]{64}$/);
  });
});
