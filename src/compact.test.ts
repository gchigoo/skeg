/**
 * compactRun：closure 不变式与有界体积。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateClosure,
  formatClosureFailure,
} from './closure.ts';
import {
  compactRun,
  maybeCompactRun,
  shouldCompactRun,
  COMPACT_CHECKS_THRESHOLD,
} from './compact.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { buildRunContract } from './contract.ts';
import { reduce } from './reducer.ts';
import { upsertCheck } from './run.ts';

describe('ClosureInvariant', () => {
  it('compactRun preserves evaluateClosure fields and stale revision', () => {
    const contract = buildRunContract(DEFAULT_CONFIG);
    let run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'long',
      risk: 'lean',
      contract,
    });
    run = upsertCheck(run, {
      kind: 'command',
      name: 'targeted-test',
      passed: true,
      evidence: 'x'.repeat(400),
      command: 'npm test -- src/a.ts '.repeat(20),
    });
    run = upsertCheck(run, {
      kind: 'diff',
      name: 'diff',
      passed: true,
    });
    run = reduce(run, {
      type: 'MUTATION_COMMITTED',
      paths: ['src/a.ts'],
    });
    // 堆积多 revision 历史
    for (let i = 0; i < 10; i++) {
      run = upsertCheck(run, {
        kind: 'command',
        name: `extra-${i}`,
        passed: true,
        evidence: `blob-${i}-${'y'.repeat(200)}`,
      });
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: [`src/f${i}.ts`],
      });
    }

    const before = evaluateClosure(run, DEFAULT_CONFIG);
    const compacted = compactRun(run);
    const after = evaluateClosure(compacted, DEFAULT_CONFIG);
    assert.deepEqual(after, before);
    assert.ok(before.stale.includes('targeted-test'));
    const whyBefore = formatClosureFailure(before, run);
    const whyAfter = formatClosureFailure(after, compacted);
    assert.match(whyBefore, /targeted-test passed at revision 0/);
    assert.match(whyAfter, /targeted-test passed at revision 0/);
    assert.ok(
      compacted.checks.every(
        (c) =>
          c.revision === compacted.revision ||
          !c.evidence ||
          c.evidence.length <= 121,
      ),
    );
  });
});

describe('RunStateBounded', () => {
  it('100 revision loop stays under 32KB after compact', () => {
    const contract = buildRunContract({
      ...DEFAULT_CONFIG,
      checks: {
        default: ['test', 'diff'],
        guarded: ['test', 'typecheck', 'lint', 'diff'],
      },
    });
    let run = reduce(null, {
      type: 'RUN_STARTED',
      intent: 'bounded',
      risk: 'lean',
      contract,
    });
    for (let i = 0; i < 100; i++) {
      run = upsertCheck(run, {
        kind: 'command',
        name: 'test',
        passed: true,
        evidence: `output ${i} ${'z'.repeat(80)}`,
        command: `npm test -- file${i}.ts`,
      });
      run = upsertCheck(run, {
        kind: 'diff',
        name: 'diff',
        passed: true,
      });
      run = reduce(run, {
        type: 'SIGNAL_RAISED',
        signal: {
          trigger: `noise-${i % 7}`,
          strength: 'weak',
          evidence: `e${i}`,
        },
      });
      if (i % 11 === 0) {
        run = reduce(run, {
          type: 'GATE_OPENED',
          gate: {
            hits: [
              {
                trigger: 'protectedPaths',
                strength: 'deterministic',
                path: `.env.${i}`,
                reason: `hit ${i}`,
              },
            ],
            actionFingerprint: `fp-${i}`,
            scope: 'call',
            trigger: 'protectedPaths',
            reason: `hit ${i}`,
          },
        });
        run = reduce(run, { type: 'GATE_RESOLVED', approved: true });
        run = reduce(run, { type: 'GATE_CLEARED' });
      }
      run = reduce(run, {
        type: 'MUTATION_COMMITTED',
        paths: [`src/x${i}.ts`],
      });
      run = maybeCompactRun(run);
    }
    assert.equal(shouldCompactRun(run) || run.checks.length <= COMPACT_CHECKS_THRESHOLD + 5, true);
    const size = JSON.stringify(run).length;
    assert.ok(size < 32 * 1024, `RunState size ${size} >= 32KB`);
    const ev = evaluateClosure(run, {
      ...DEFAULT_CONFIG,
      checks: {
        default: ['test', 'diff'],
        guarded: ['test', 'typecheck', 'lint', 'diff'],
      },
    });
    // 最新 revision 无 fresh pass → stale 或 missing
    assert.equal(ev.ok, false);
  });
});
