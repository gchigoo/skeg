/**
 * Provider trust 存储与路径边界。
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  assertSelfContainedProvider,
  checkProviderTrust,
  classifyProviderSpec,
  findRelativeRuntimeImport,
  hashProviderContent,
  loadTrustStore,
  loadTrustStoreWithDiagnostics,
  saveTrustStore,
  trustProvider,
  untrustProvider,
} from './trust.ts';

describe('classifyProviderSpec', () => {
  it('allows .veritack/providers relative paths', () => {
    const ok = classifyProviderSpec('.veritack/providers/foo.mjs');
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.kind, 'workspace-file');
      assert.equal(ok.relative, '.veritack/providers/foo.mjs');
    }
  });

  it('allows bare and scoped package names', () => {
    assert.equal(classifyProviderSpec('veritack-postgres').ok, true);
    assert.equal(classifyProviderSpec('@acme/veritack-policy').ok, true);
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
    userDir = mkdtempSync(join(tmpdir(), 'veritack-trust-user-'));
    cwd = mkdtempSync(join(tmpdir(), 'veritack-trust-cwd-'));
    prevUserDir = process.env.VERITACK_USER_DIR;
    process.env.VERITACK_USER_DIR = userDir;
    mkdirSync(join(cwd, '.veritack', 'providers'), { recursive: true });
    writeFileSync(
      join(cwd, '.veritack', 'providers', 'special.mjs'),
      'export default { checks: { classify() { return null; } } };\n',
      'utf8',
    );
  });

  afterEach(() => {
    if (prevUserDir === undefined) delete process.env.VERITACK_USER_DIR;
    else process.env.VERITACK_USER_DIR = prevUserDir;
    rmSync(userDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('requires explicit trust and binds content hash', () => {
    const spec = '.veritack/providers/special.mjs';
    const before = checkProviderTrust(cwd, spec);
    assert.equal(before.trusted, false);

    const trusted = trustProvider(cwd, spec);
    assert.equal(trusted.ok, true);
    const after = checkProviderTrust(cwd, spec);
    assert.equal(after.trusted, true);

    writeFileSync(
      join(cwd, '.veritack', 'providers', 'special.mjs'),
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
    const spec = '.veritack/providers/special.mjs';
    assert.equal(trustProvider(cwd, spec).ok, true);
    assert.equal(untrustProvider(cwd, spec).ok, true);
    assert.equal(checkProviderTrust(cwd, spec).trusted, false);
  });

  it('hashes workspace provider content', () => {
    const hashed = hashProviderContent(cwd, '.veritack/providers/special.mjs');
    assert.equal(hashed.ok, true);
    if (hashed.ok) assert.match(hashed.hash, /^[a-f0-9]{64}$/);
  });

  it('rejects relative runtime imports (ProviderHelperHashBypass)', () => {
    const multi = join(cwd, '.veritack', 'providers', 'multi.mjs');
    writeFileSync(
      multi,
      'import { x } from "./helper.mjs";\nexport default { apiVersion: 1, id: "m", capabilities: [] };\n',
      'utf8',
    );
    assert.ok(findRelativeRuntimeImport(readFileSync(multi, 'utf8')));
    const self = assertSelfContainedProvider(multi);
    assert.equal(self.ok, false);
    const trusted = trustProvider(cwd, '.veritack/providers/multi.mjs');
    assert.equal(trusted.ok, false);
  });

  it('atomic write preserves trust store content', () => {
    const spec = '.veritack/providers/special.mjs';
    assert.equal(trustProvider(cwd, spec).ok, true);
    const store = loadTrustStore();
    assert.equal(store.providers.length, 1);
    saveTrustStore(store);
    const again = loadTrustStore();
    assert.equal(again.providers.length, 1);
    assert.equal(again.providers[0]?.spec, spec);
    const body = readFileSync(join(userDir, 'trust.json'), 'utf8');
    assert.ok(body.includes(spec));
  });

  it('backs up corrupt trust.json and does not silently trust (TrustStoreSilentWipe)', () => {
    writeFileSync(join(userDir, 'trust.json'), '{not-json', 'utf8');
    const result = loadTrustStoreWithDiagnostics();
    assert.equal(result.store.providers.length, 0);
    assert.ok(result.diagnostics.some((d) => d.level === 'error'));
    assert.ok(result.corruptBackup);
    assert.ok(existsSync(result.corruptBackup!));
    const backups = readdirSync(userDir).filter((f) =>
      f.startsWith('trust.json.corrupt-'),
    );
    assert.ok(backups.length >= 1);
    // 损坏后不得静默信任任何 provider
    assert.equal(
      checkProviderTrust(cwd, '.veritack/providers/special.mjs').trusted,
      false,
    );
  });
});
