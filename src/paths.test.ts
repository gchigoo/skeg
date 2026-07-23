/**
 * paths：bash 写文件检测与路径提取；realpath 边界。
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  authorizeMutationPaths,
  extractBashWritePaths,
  isBashFileWrite,
  pathMatchCandidates,
  toWorkspacePath,
} from './paths.ts';

describe('isBashFileWrite', () => {
  it('detects redirects, tee, sed -i, cp/mv/touch', () => {
    assert.equal(isBashFileWrite('echo hi > src/foo.ts'), true);
    assert.equal(isBashFileWrite('cat <<EOF >> .gitignore'), true);
    assert.equal(isBashFileWrite('tee src/util.js'), true);
    assert.equal(isBashFileWrite("sed -i 's/a/b/' src/util.js"), true);
    assert.equal(isBashFileWrite('cp a.md b.md'), true);
    assert.equal(isBashFileWrite('mv old.ts new.ts'), true);
    assert.equal(isBashFileWrite('touch .veritack/records/.keep'), true);
  });

  it('ignores read-only commands', () => {
    assert.equal(isBashFileWrite('ls src'), false);
    assert.equal(isBashFileWrite('npm test'), false);
    assert.equal(isBashFileWrite('rg -n foo src'), false);
    assert.equal(isBashFileWrite('git status'), false);
    assert.equal(isBashFileWrite('node --test tests/foo.js'), false);
  });
});

describe('extractBashWritePaths', () => {
  it('extracts redirect targets', () => {
    assert.deepEqual(extractBashWritePaths('echo x > src/foo.ts'), [
      'src/foo.ts',
    ]);
    assert.deepEqual(extractBashWritePaths('printf y >> .gitignore'), [
      '.gitignore',
    ]);
  });

  it('extracts tee targets', () => {
    assert.deepEqual(extractBashWritePaths('echo x | tee src/util.js'), [
      'src/util.js',
    ]);
  });

  it('falls back to path-like tokens for sed/cp', () => {
    const sed = extractBashWritePaths("sed -i 's/a/b/' src/util.js");
    assert.ok(sed.includes('src/util.js'));
    const cp = extractBashWritePaths('cp templates/a.md docs/a.md');
    assert.ok(cp.includes('docs/a.md'));
  });

  it('returns empty for non-write commands', () => {
    assert.deepEqual(extractBashWritePaths('npm test'), []);
  });
});

describe('pathMatchCandidates', () => {
  it('includes relative suffixes for absolute windows paths', () => {
    const c = pathMatchCandidates('D:/Projects/ado/package.json');
    assert.ok(c.includes('package.json'));
  });
});

describe('toWorkspacePath', () => {
  it('normalizes relative paths and resolves ..', () => {
    const r = toWorkspacePath('/proj', 'src/../.env');
    assert.equal(r.relativePath, '.env');
    assert.equal(r.outsideWorkspace, false);
  });

  it('flags paths outside workspace', () => {
    const r = toWorkspacePath('/proj', '/other/secret');
    assert.equal(r.outsideWorkspace, true);
  });
});

describe('authorizeMutationPaths', () => {
  it('allows workspace-relative writes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'veritack-auth-ok-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      const r = authorizeMutationPaths(cwd, ['src/a.ts', './b.ts']);
      assert.deepEqual(r.allowed, ['src/a.ts', 'b.ts']);
      assert.equal(r.blocked.length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks outside workspace and .git writes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'veritack-auth-block-'));
    try {
      mkdirSync(join(cwd, '.git'), { recursive: true });
      mkdirSync(join(cwd, 'src'), { recursive: true });
      const r = authorizeMutationPaths(cwd, [
        '../outside.txt',
        '.git/config',
        'src/ok.ts',
      ]);
      assert.deepEqual(r.allowed, ['src/ok.ts']);
      assert.equal(r.blocked.length, 2);
      assert.ok(r.blocked.some((b) => b.path.includes('outside')));
      assert.ok(r.blocked.some((b) => b.path.includes('.git')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('SymlinkBoundaryEscape', () => {
  it('blocks symlink to outside workspace', { skip: process.platform === 'win32' ? 'posix symlink' : false }, () => {
    const root = mkdtempSync(join(tmpdir(), 'veritack-sym-'));
    const cwd = join(root, 'ws');
    const outside = join(root, 'outside');
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'x');
      symlinkSync(outside, join(cwd, 'link'));
      const r = authorizeMutationPaths(cwd, ['link/secret.txt']);
      assert.equal(r.allowed.length, 0);
      assert.ok(r.blocked.some((b) => /escapes workspace/i.test(b.reason)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks symlink to .git', { skip: process.platform === 'win32' ? 'posix symlink' : false }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'veritack-symgit-'));
    try {
      mkdirSync(join(cwd, '.git'), { recursive: true });
      writeFileSync(join(cwd, '.git', 'config'), 'x');
      symlinkSync(join(cwd, '.git'), join(cwd, 'gitlink'));
      const r = authorizeMutationPaths(cwd, ['gitlink/config']);
      assert.equal(r.allowed.length, 0);
      assert.ok(r.blocked.length > 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks Windows junction to outside', { skip: process.platform !== 'win32' ? 'windows junction' : false }, () => {
    const root = mkdtempSync(join(tmpdir(), 'veritack-junc-'));
    const cwd = join(root, 'ws');
    const outside = join(root, 'outside');
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'x');
      symlinkSync(outside, join(cwd, 'link'), 'junction');
      const r = authorizeMutationPaths(cwd, ['link/secret.txt']);
      assert.equal(r.allowed.length, 0);
      assert.ok(r.blocked.some((b) => /escapes workspace/i.test(b.reason)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks new file under symlink parent pointing outside', { skip: process.platform === 'win32' ? 'posix symlink' : false }, () => {
    const root = mkdtempSync(join(tmpdir(), 'veritack-symnew-'));
    const cwd = join(root, 'ws');
    const outside = join(root, 'outside');
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(cwd, 'outlink'));
      const r = authorizeMutationPaths(cwd, ['outlink/new-result.txt']);
      assert.equal(r.allowed.length, 0);
      assert.ok(r.blocked.some((b) => /escapes workspace/i.test(b.reason)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
