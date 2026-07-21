import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRecord, normalizeType, parseRecordArgs } from './record.ts';
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
