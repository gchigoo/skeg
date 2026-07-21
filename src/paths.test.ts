/**
 * paths：bash 写文件检测与路径提取。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractBashWritePaths,
  isBashFileWrite,
  pathMatchCandidates,
} from './paths.ts';

describe('isBashFileWrite', () => {
  it('detects redirects, tee, sed -i, cp/mv/touch', () => {
    assert.equal(isBashFileWrite('echo hi > src/foo.ts'), true);
    assert.equal(isBashFileWrite('cat <<EOF >> .gitignore'), true);
    assert.equal(isBashFileWrite('tee src/util.js'), true);
    assert.equal(isBashFileWrite("sed -i 's/a/b/' src/util.js"), true);
    assert.equal(isBashFileWrite('cp a.md b.md'), true);
    assert.equal(isBashFileWrite('mv old.ts new.ts'), true);
    assert.equal(isBashFileWrite('touch .skeg/records/.keep'), true);
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
