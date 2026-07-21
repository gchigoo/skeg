import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createRecord,
  listRecords,
  normalizeType,
  parseRecordArgs,
} from './record.ts';
import { createRun } from './run.ts';

describe('parseRecordArgs', () => {
  it('parses type and title', () => {
    const parsed = parseRecordArgs('decision Auth boundary');
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.type, 'decision');
      assert.equal(parsed.title, 'Auth boundary');
      assert.equal(parsed.body, '');
    }
  });

  it('parses body after pipe', () => {
    const parsed = parseRecordArgs('incident Cache stampede | clear query on logout');
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.type, 'incident');
      assert.equal(parsed.title, 'Cache stampede');
      assert.equal(parsed.body, 'clear query on logout');
    }
  });

  it('parses --type flag', () => {
    const parsed = parseRecordArgs('--type migration Add users.email index');
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.type, 'migration');
      assert.equal(parsed.title, 'Add users.email index');
    }
  });

  it('rejects missing title', () => {
    const parsed = parseRecordArgs('decision');
    assert.equal(parsed.ok, false);
  });
});

describe('normalizeType', () => {
  it('accepts aliases', () => {
    assert.equal(normalizeType('adr'), 'decision');
    assert.equal(normalizeType('mig'), 'migration');
    assert.equal(normalizeType('INC'), 'incident');
  });
});

describe('createRecord', () => {
  it('writes lazy records dir with sequenced id', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-record-'));
    try {
      const run = createRun('fix avatar cache');
      const first = createRecord(cwd, {
        type: 'incident',
        title: 'Cache stampede',
        body: 'Clear current-user query on logout.',
        run,
      });
      const second = createRecord(cwd, {
        type: 'incident',
        title: 'Another',
      });

      assert.equal(first.id, 'INC-001');
      assert.equal(second.id, 'INC-002');
      assert.equal(first.relativePath, '.skeg/records/INC-001-cache-stampede.md');

      const text = readFileSync(join(cwd, first.relativePath), 'utf8');
      assert.match(text, /type: incident/);
      assert.match(text, /runId: run_/);
      assert.match(text, /Clear current-user query/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('listRecords', () => {
  it('returns empty when records dir missing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-list-empty-'));
    try {
      assert.deepEqual(listRecords(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('sorts by createdAt desc and respects limit', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-list-sort-'));
    try {
      const dir = join(cwd, '.skeg', 'records');
      mkdirSync(dir, { recursive: true });
      const write = (
        id: string,
        type: string,
        title: string,
        createdAt: string,
      ) => {
        writeFileSync(
          join(dir, `${id}-slug.md`),
          [
            '---',
            `type: ${type}`,
            `id: ${id}`,
            `title: ${title}`,
            `createdAt: ${createdAt}`,
            '---',
            '',
            `# ${title}`,
            '',
          ].join('\n'),
          'utf8',
        );
      };
      write('DEC-001', 'decision', 'First', '2026-07-01T00:00:00.000Z');
      write('MIG-001', 'migration', 'Second', '2026-07-02T00:00:00.000Z');
      write('INC-001', 'incident', 'Third', '2026-07-03T00:00:00.000Z');

      const all = listRecords(cwd, 10);
      assert.equal(all.length, 3);
      assert.equal(all[0].id, 'INC-001');
      assert.equal(all[1].id, 'MIG-001');
      assert.equal(all[2].id, 'DEC-001');

      const limited = listRecords(cwd, 2);
      assert.equal(limited.length, 2);
      assert.equal(limited[0].id, 'INC-001');
      assert.equal(limited[1].id, 'MIG-001');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('unquotes escaped titles', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skeg-list-quote-'));
    try {
      createRecord(cwd, {
        type: 'decision',
        title: 'Auth: clear session on logout',
      });
      const listed = listRecords(cwd, 1);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].title, 'Auth: clear session on logout');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
