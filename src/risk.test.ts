import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './config.ts';
import {
  commandFingerprint,
  detectDangerousCommand,
  detectPathRisks,
  findExportSymbolChanges,
  findSensitiveKeywords,
  gateAcknowledgementKey,
  isControlPlanePath,
  requiresGate,
  scanSensitiveKeywords,
  scanToolCall,
} from './risk.ts';

describe('controlPlane', () => {
  it('flags .skeg/config.json and providers paths', () => {
    assert.equal(isControlPlanePath('.skeg/config.json'), true);
    assert.equal(isControlPlanePath('.skeg/providers/foo.mjs'), true);
    assert.equal(isControlPlanePath('src/a.ts'), false);
    const hits = detectPathRisks('.skeg/config.json', DEFAULT_CONFIG);
    assert.ok(hits.some((h) => h.trigger === 'controlPlane'));
    assert.equal(requiresGate('controlPlane', {
      ...DEFAULT_CONFIG,
      policies: {
        ...DEFAULT_CONFIG.policies,
        controlPlane: { risk: 'lean', action: 'ignore' },
      },
    }), true);
  });

  it('scanToolCall flags write to control plane', () => {
    const hits = scanToolCall(
      'write',
      { path: '.skeg/config.json' },
      DEFAULT_CONFIG,
    );
    assert.ok(hits.some((h) => h.trigger === 'controlPlane'));
    const bashHits = scanToolCall(
      'bash',
      { command: 'echo x > .skeg/config.json' },
      DEFAULT_CONFIG,
    );
    assert.ok(bashHits.some((h) => h.trigger === 'controlPlane'));
  });
});

describe('detectPathRisks', () => {
  it('flags migration paths deterministically', () => {
    const hits = detectPathRisks('migrations/001_users.sql', DEFAULT_CONFIG);
    assert.equal(hits.some((h) => h.trigger === 'databaseMigration'), true);
    assert.equal(
      hits.find((h) => h.trigger === 'databaseMigration')?.strength,
      'deterministic',
    );
  });

  it('flags dependency manifests', () => {
    const hits = detectPathRisks('package.json', DEFAULT_CONFIG);
    assert.equal(hits.some((h) => h.trigger === 'dependencyChange'), true);
  });

  it('flags absolute dependency paths (Windows-style)', () => {
    const hits = detectPathRisks(
      'D:/Projects/ado-bug-agent/package.json',
      DEFAULT_CONFIG,
    );
    assert.equal(hits.some((h) => h.trigger === 'dependencyChange'), true);
  });

  it('flags absolute auth paths against relative authPaths', () => {
    const config = {
      ...DEFAULT_CONFIG,
      authPaths: ['src/auth/**'],
    };
    const hits = detectPathRisks(
      'D:/Projects/ado-bug-agent/src/auth/login.ts',
      config,
    );
    assert.equal(hits.some((h) => h.trigger === 'authChange'), true);
  });

  it('flags protected paths', () => {
    const hits = detectPathRisks('.env.local', DEFAULT_CONFIG);
    assert.equal(hits.some((h) => h.trigger === 'protectedPaths'), true);
  });

  it('does not flag auth without authPaths config', () => {
    const hits = detectPathRisks('src/auth/login.ts', DEFAULT_CONFIG);
    assert.equal(hits.some((h) => h.trigger === 'authChange'), false);
  });

  it('flags auth when authPaths configured', () => {
    const config = {
      ...DEFAULT_CONFIG,
      authPaths: ['src/auth/**'],
    };
    const hits = detectPathRisks('src/auth/login.ts', config);
    assert.equal(hits.some((h) => h.trigger === 'authChange'), true);
    assert.equal(
      hits.find((h) => h.trigger === 'authChange')?.strength,
      'deterministic',
    );
  });

  it('flags api when apiPaths configured', () => {
    const config = {
      ...DEFAULT_CONFIG,
      apiPaths: ['src/api/public/**'],
    };
    const hits = detectPathRisks('src/api/public/users.ts', config);
    assert.equal(hits.some((h) => h.trigger === 'publicApiChange'), true);
  });
});

describe('detectDangerousCommand', () => {
  it('flags rm -rf', () => {
    const hit = detectDangerousCommand('rm -rf /tmp/foo');
    assert.ok(hit);
    assert.equal(hit?.trigger, 'dangerousCommand');
    assert.ok(hit?.fingerprint);
  });

  it('allows safe commands', () => {
    assert.equal(detectDangerousCommand('pnpm test'), null);
  });

  it('gives distinct acknowledgement keys for different dangerous commands', () => {
    const a = detectDangerousCommand('rm -rf /tmp/foo');
    const b = detectDangerousCommand('git push --force origin main');
    assert.ok(a && b);
    assert.notEqual(
      gateAcknowledgementKey(a!),
      gateAcknowledgementKey(b!),
    );
  });

  it('reuses acknowledgement key for the same normalized command', () => {
    const a = detectDangerousCommand('rm -rf /tmp/foo');
    const b = detectDangerousCommand('rm  -rf   /tmp/foo');
    assert.ok(a && b);
    assert.equal(gateAcknowledgementKey(a!), gateAcknowledgementKey(b!));
    assert.equal(commandFingerprint('rm -rf /tmp/foo'), a!.fingerprint);
  });
});

describe('scanToolCall', () => {
  it('gates write to migrations', () => {
    const hits = scanToolCall(
      'write',
      { path: 'migrations/002.sql', content: 'ALTER TABLE' },
      DEFAULT_CONFIG,
    );
    assert.equal(hits.some((h) => h.trigger === 'databaseMigration'), true);
  });

  it('does not gate read of migrations', () => {
    const hits = scanToolCall(
      'read',
      { path: 'migrations/002.sql' },
      DEFAULT_CONFIG,
    );
    assert.equal(hits.length, 0);
  });
});

describe('scanSensitiveKeywords', () => {
  it('detects auth-related keywords for prove fallback', () => {
    assert.equal(scanSensitiveKeywords('clear session token on logout'), true);
    assert.equal(scanSensitiveKeywords('rename button label'), false);
    assert.deepEqual(findSensitiveKeywords('session and permission'), [
      'session',
      'permission',
    ]);
  });
});

describe('findExportSymbolChanges', () => {
  it('extracts added export lines from unified diff', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '+export function foo() {}',
      '-export const bar = 1',
      '+const baz = 2',
    ].join('\n');
    const changes = findExportSymbolChanges(diff);
    assert.equal(changes.length, 2);
    assert.ok(changes.some((l) => l.includes('foo')));
  });
});
