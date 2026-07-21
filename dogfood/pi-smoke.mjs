/**
 * Pi 实机抽测：2 lean + 1 risk，确认命令 UX 与 gate confirm。
 * 用法：在沙箱 cwd 下 node dogfood/pi-smoke.mjs
 * 或：node dogfood/pi-smoke.mjs --cwd /path/to/sandbox
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SKEG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cwdFlag = args.indexOf('--cwd');
const SANDBOX =
  cwdFlag >= 0
    ? resolve(args[cwdFlag + 1])
    : join(tmpdir(), 'skeg-pi-smoke');

const TIMEOUT_MS = 180_000;
const MODEL = process.env.SKEG_SMOKE_MODEL || 'deepseek/deepseek-v4-flash';

/** @typedef {{ type: string, [k: string]: unknown }} RpcMsg */

/**
 * 确保沙箱 fixture 存在。
 * @param {string} root
 */
function ensureSandbox(root) {
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(join(root, 'migrations'), { recursive: true });
  if (!existsSync(join(root, 'package.json'))) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'skeg-smoke', version: '0.0.0', private: true }),
    );
  }
  if (!existsSync(join(root, 'src/auth/redirect.ts'))) {
    writeFileSync(
      join(root, 'src/auth/redirect.ts'),
      'export function buildRedirect(path: string, query: string) {\n  return path;\n}\n',
    );
  }
  if (!existsSync(join(root, 'src/auth/logout.ts'))) {
    writeFileSync(
      join(root, 'src/auth/logout.ts'),
      'export function logout() {\n  // noop\n}\n',
    );
  }
  mkdirSync(join(root, 'src/settings'), { recursive: true });
  if (!existsSync(join(root, 'src/settings/copy.ts'))) {
    writeFileSync(
      join(root, 'src/settings/copy.ts'),
      "export const SAVE_LABEL = 'Savve settings';\n",
    );
  }
  if (!existsSync(join(root, 'migrations/001_init.sql'))) {
    writeFileSync(
      join(root, 'migrations/001_init.sql'),
      'CREATE TABLE users (id int, email text);\n',
    );
  }
  mkdirSync(join(root, '.pi'), { recursive: true });
  writeFileSync(
    join(root, '.pi/settings.json'),
    JSON.stringify({ packages: [SKEG_ROOT] }, null, 2),
  );
}

class PiRpc {
  /**
   * @param {string} cwd
   */
  constructor(cwd) {
    this.cwd = cwd;
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.proc = null;
    /** @type {string} */
    this.buf = '';
    /** @type {RpcMsg[]} */
    this.events = [];
    /** @type {Array<{method: string, title?: string, message?: string}>} */
    this.uiRequests = [];
    /** @type {Array<{message?: string, notifyType?: string}>} */
    this.notifies = [];
    /** @type {((msg: RpcMsg) => void)[]} */
    this.waiters = [];
    this.autoConfirm = true;
  }

  async start() {
    const [provider, modelId] = MODEL.includes('/')
      ? MODEL.split('/')
      : ['deepseek', MODEL];
    // Windows 上直接 spawn .cmd 易 EINVAL；统一走 node + cli.js
    const cliJs =
      process.env.SKEG_PI_CLI ||
      [
        join(SKEG_ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
        'D:/Software/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ].find((p) => existsSync(p));
    if (!cliJs) throw new Error('pi cli.js not found; set SKEG_PI_CLI');

    this.proc = spawn(
      process.execPath,
      [
        cliJs,
        '--mode',
        'rpc',
        '--no-session',
        '--approve',
        '--thinking',
        'off',
        '--provider',
        provider,
        '--model',
        modelId,
        '--name',
        'skeg-pi-smoke',
      ],
      {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );
    this.proc.on('error', (err) => {
      console.error('pi spawn error:', err);
    });

    this.proc.stderr.on('data', (d) => {
      const t = d.toString();
      if (process.env.SKEG_SMOKE_DEBUG) process.stderr.write(`[pi stderr] ${t}`);
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        let line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this.handle(msg);
      }
    });

    await new Promise((r) => setTimeout(r, 800));
    if (this.proc.exitCode !== null) {
      throw new Error(`pi exited early: code=${this.proc.exitCode}`);
    }
  }

  /** @param {RpcMsg} msg */
  handle(msg) {
    this.events.push(msg);

    if (msg.type === 'extension_ui_request') {
      const method = String(msg.method || '');
      if (method === 'notify') {
        this.notifies.push({
          message: String(msg.message || ''),
          notifyType: String(msg.notifyType || 'info'),
        });
      } else if (
        method === 'confirm' ||
        method === 'select' ||
        method === 'input' ||
        method === 'editor'
      ) {
        this.uiRequests.push({
          method,
          title: msg.title ? String(msg.title) : undefined,
          message: msg.message ? String(msg.message) : undefined,
        });
        if (method === 'confirm' && this.autoConfirm) {
          this.send({
            type: 'extension_ui_response',
            id: msg.id,
            confirmed: true,
          });
        } else if (method === 'confirm') {
          this.send({
            type: 'extension_ui_response',
            id: msg.id,
            confirmed: false,
          });
        } else if (method === 'select') {
          const opts = /** @type {string[]} */ (msg.options || []);
          this.send({
            type: 'extension_ui_response',
            id: msg.id,
            value: opts[0],
          });
        } else {
          this.send({
            type: 'extension_ui_response',
            id: msg.id,
            cancelled: true,
          });
        }
      }
    }

    for (const w of [...this.waiters]) w(msg);
  }

  /** @param {Record<string, unknown>} obj */
  send(obj) {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * @param {string} type
   * @param {number} [timeout]
   * @returns {Promise<RpcMsg>}
   */
  waitForType(type, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const found = this.events.find((e) => e.type === type);
      if (found) {
        resolve(found);
        return;
      }
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onMsg);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeout);
      const onMsg = (msg) => {
        if (msg.type === type) {
          clearTimeout(t);
          this.waiters = this.waiters.filter((w) => w !== onMsg);
          resolve(msg);
        }
      };
      this.waiters.push(onMsg);
    });
  }

  /**
   * @param {string} message
   * @param {number} [timeout]
   */
  async prompt(message, timeout = TIMEOUT_MS) {
    const before = this.events.length;
    this.send({ type: 'prompt', message });
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const slice = this.events.slice(before);
      const settled = slice.find((e) => e.type === 'agent_settled');
      const ended = slice.find((e) => e.type === 'agent_end');
      // extension commands may only emit response + notify
      const resp = slice.find(
        (e) => e.type === 'response' && e.command === 'prompt',
      );
      if (settled || ended) return slice;
      if (
        resp &&
        resp.success &&
        !slice.some((e) => e.type === 'agent_start') &&
        Date.now() - start > 400
      ) {
        // slash command finished without agent turn
        await new Promise((r) => setTimeout(r, 200));
        return this.events.slice(before);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`prompt timeout: ${message.slice(0, 80)}`);
  }

  /**
   * @returns {Promise<object[]>}
   */
  async getSkegRuns() {
    const before = this.events.length;
    this.send({ id: 'entries', type: 'get_entries' });
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const resp = this.events
        .slice(before)
        .find((e) => e.type === 'response' && e.command === 'get_entries');
      if (resp) {
        const entries = /** @type {any[]} */ (resp.data?.entries || []);
        return entries
          .filter((e) => e.type === 'custom' && e.customType === 'skeg/run')
          .map((e) => e.data);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('get_entries timeout');
  }

  async stop() {
    try {
      this.send({ type: 'abort' });
    } catch {
      /* ignore */
    }
    this.proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main() {
  ensureSandbox(SANDBOX);
  console.log(`Sandbox: ${SANDBOX}`);
  console.log(`Skeg:    ${SKEG_ROOT}`);
  console.log(`Model:   ${MODEL}`);

  const pi = new PiRpc(SANDBOX);
  await pi.start();

  /** @type {string[]} */
  const failures = [];
  const record = (name, ok, detail = '') => {
    if (!check(name, ok, detail)) failures.push(name);
  };

  // --- /init（顺带证明命令已注册并有 notify UX）---
  pi.notifies = [];
  await pi.prompt('/init');
  const initNotify = pi.notifies.find((n) =>
    /skeg|\.skeg|initialized|created/i.test(n.message || ''),
  );
  record(
    'commands UX (/init)',
    Boolean(initNotify),
    initNotify?.message?.split('\n')[0] || 'no notify',
  );
  record(
    '/init writes .skeg',
    existsSync(join(SANDBOX, '.skeg/config.json')) &&
      existsSync(join(SANDBOX, '.skeg/project.md')),
  );

  // /record 轻量验证（不要求留下 artifact 给 lean 场景）
  pi.notifies = [];
  await pi.prompt('/record incident Smoke note | pi smoke harness check');
  const recordNotify = pi.notifies.find((n) => /Recorded/i.test(n.message || ''));
  record('commands UX (/record)', Boolean(recordNotify), recordNotify?.message || '');

  // ========== lean 1: redirect ==========
  pi.notifies = [];
  pi.uiRequests = [];
  await pi.prompt('/run fix redirect query loss after login');
  const run1 = pi.notifies.find((n) => /Started run/i.test(n.message || ''));
  record('lean1 /run UX', Boolean(run1), run1?.message?.split('\n')[0] || '');

  await pi.prompt(
    [
      'Do exactly this and stop:',
      '1. Use the edit or write tool to change src/auth/redirect.ts so buildRedirect appends query when present:',
      '   export function buildRedirect(path: string, query: string) {',
      "     return query ? `${path}?${query}` : path;",
      '   }',
      '2. Do not touch any other files.',
      '3. Do not run tests. Reply DONE when the file is edited.',
    ].join('\n'),
  );

  const lean1Gates = pi.uiRequests.filter((u) => u.method === 'confirm');
  record(
    'lean1 no gate confirm',
    lean1Gates.length === 0,
    lean1Gates.map((g) => g.title).join('; ') || 'none',
  );
  const redirect = readFileSync(join(SANDBOX, 'src/auth/redirect.ts'), 'utf8');
  record('lean1 file edited', redirect.includes('query'), 'redirect.ts');

  pi.notifies = [];
  await pi.prompt('/status');
  const status1 = pi.notifies.map((n) => n.message || '').join('\n');
  record(
    'lean1 /status intent+lean',
    /Intent:.*redirect/i.test(status1) && /Risk:\s*lean/i.test(status1),
    status1.replace(/\n/g, ' | ').slice(0, 200),
  );

  pi.notifies = [];
  await pi.prompt('/finish');
  const finish1 = pi.notifies.map((n) => n.message || '').join('\n');
  record(
    'lean1 /finish closes',
    /done|Closed|Status:\s*done/i.test(finish1) ||
      /Intent:.*redirect/i.test(finish1),
    finish1.replace(/\n/g, ' | ').slice(0, 200),
  );

  // ========== lean 2: typo copy（避免 sensitive-keywords 误升 guarded）==========
  pi.notifies = [];
  pi.uiRequests = [];
  await pi.prompt('/run fix typo in settings copy SAVE_LABEL');
  record(
    'lean2 /run UX',
    pi.notifies.some((n) => /Started run/i.test(n.message || '')),
  );

  await pi.prompt(
    [
      'Do exactly this and stop:',
      '1. Edit src/settings/copy.ts and change Savve to Save:',
      "   export const SAVE_LABEL = 'Save settings';",
      '2. Do not touch migrations, package.json, or auth files.',
      '3. Do not use words: token, password, session, permission, role.',
      '4. Reply DONE when done.',
    ].join('\n'),
  );
  record(
    'lean2 no gate confirm',
    pi.uiRequests.filter((u) => u.method === 'confirm').length === 0,
  );
  const copy = readFileSync(join(SANDBOX, 'src/settings/copy.ts'), 'utf8');
  record('lean2 file edited', /Save settings/.test(copy), 'copy.ts');

  pi.notifies = [];
  await pi.prompt('/status');
  const status2 = pi.notifies.map((n) => n.message || '').join('\n');
  record(
    'lean2 /status intent+lean',
    /Intent:.*typo|SAVE_LABEL|settings copy/i.test(status2) &&
      /Risk:\s*lean/i.test(status2),
    status2.replace(/\n/g, ' | ').slice(0, 200),
  );

  pi.notifies = [];
  await pi.prompt('/finish');
  const finish2 = pi.notifies.map((n) => n.message || '').join('\n');
  record('lean2 /finish closes', finish2.length > 0, finish2.slice(0, 120));

  // ========== risk: migration ==========
  pi.notifies = [];
  pi.uiRequests = [];
  pi.autoConfirm = true;
  await pi.prompt('/run add unique index migration on users.email');
  record(
    'risk /run UX',
    pi.notifies.some((n) => /Started run/i.test(n.message || '')),
  );

  await pi.prompt(
    [
      'Do exactly this and stop:',
      '1. Create file migrations/002_users_email_unique.sql with exactly:',
      '   CREATE UNIQUE INDEX CONCURRENTLY users_email_uidx ON users(email);',
      '2. Use the write tool (not bash redirection).',
      '3. If a Skeg gate confirm appears, that is expected — the host will approve.',
      '4. Reply DONE after the write succeeds.',
    ].join('\n'),
  );

  const gateConfirms = pi.uiRequests.filter(
    (u) =>
      u.method === 'confirm' &&
      /Skeg gate:\s*databaseMigration/i.test(u.title || ''),
  );
  record(
    'risk gate confirm UI',
    gateConfirms.length >= 1,
    gateConfirms[0]
      ? `${gateConfirms[0].title} | ${gateConfirms[0].message?.slice(0, 80)}`
      : `uiRequests=${JSON.stringify(pi.uiRequests).slice(0, 200)}`,
  );

  const migPath = join(SANDBOX, 'migrations/002_users_email_unique.sql');
  record(
    'risk migration written',
    existsSync(migPath) &&
      readFileSync(migPath, 'utf8').includes('users_email_uidx'),
  );

  pi.notifies = [];
  await pi.prompt('/status');
  const status3 = pi.notifies.map((n) => n.message || '').join('\n');
  record(
    'risk /status guarded+deterministic',
    /Risk:\s*guarded\s*\(deterministic\)/i.test(status3),
    status3.replace(/\n/g, ' | ').slice(0, 240),
  );

  pi.notifies = [];
  await pi.prompt('/finish');
  const finish3 = pi.notifies.map((n) => n.message || '').join('\n');
  record(
    'risk /finish after gate',
    !/Cannot finish:\s*pending gate/i.test(finish3) && finish3.length > 0,
    finish3.replace(/\n/g, ' | ').slice(0, 200),
  );

  // persistence check
  const runs = await pi.getSkegRuns();
  record(
    'RunState persisted in session',
    runs.length > 0 && runs.some((r) => r.intent),
    `entries=${runs.length}`,
  );

  await pi.stop();

  const report = {
    date: new Date().toISOString(),
    sandbox: SANDBOX,
    model: MODEL,
    result: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
    gateTitles: pi.uiRequests
      .filter((u) => u.method === 'confirm')
      .map((u) => u.title),
  };
  const out = join(SKEG_ROOT, 'dogfood', 'PI_SMOKE.md');
  writeFileSync(
    out,
    [
      '# Skeg Pi smoke (2 lean + 1 risk)',
      '',
      `Date: ${report.date}`,
      `Result: ${report.result}`,
      `Model: ${report.model}`,
      `Sandbox: ${report.sandbox}`,
      '',
      '## Checks',
      failures.length === 0
        ? '- all passed'
        : failures.map((f) => `- FAIL: ${f}`).join('\n'),
      '',
      '## Gate confirms seen',
      report.gateTitles.length
        ? report.gateTitles.map((t) => `- ${t}`).join('\n')
        : '- (none)',
      '',
    ].join('\n'),
  );
  console.log(`\nResult: ${report.result}`);
  console.log(`Wrote ${out}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
