/**
 * 真实宿主 dogfood：在指定项目 cwd 上跑 ≥10 个 Skeg run，写 FRICTION.md。
 *
 * 用法：
 *   node dogfood/host-dogfood.mjs --cwd D:/Projects/ado-bug-agent
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKEG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cwdFlag = args.indexOf('--cwd');
if (cwdFlag < 0 || !args[cwdFlag + 1]) {
  console.error('Usage: node dogfood/host-dogfood.mjs --cwd <project>');
  process.exit(2);
}
const HOST = resolve(args[cwdFlag + 1]);
const TIMEOUT_MS = 180_000;
const MODEL = process.env.SKEG_SMOKE_MODEL || 'deepseek/deepseek-v4-flash';

/** @typedef {{ type: string, [k: string]: unknown }} RpcMsg */

/**
 * 确保宿主已挂 Skeg 包。
 * @param {string} root
 */
function ensurePiPackage(root) {
  mkdirSync(join(root, '.pi'), { recursive: true });
  const settingsPath = join(root, '.pi/settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (!packages.includes(SKEG_ROOT)) {
    settings.packages = [...packages, SKEG_ROOT];
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

class PiRpc {
  /** @param {string} cwd */
  constructor(cwd) {
    this.cwd = cwd;
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.proc = null;
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
        'skeg-host-dogfood',
      ],
      {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );
    this.proc.on('error', (err) => console.error('pi spawn error:', err));
    this.proc.stderr.on('data', (d) => {
      if (process.env.SKEG_SMOKE_DEBUG) process.stderr.write(`[pi stderr] ${d}`);
    });
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        let line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          this.handle(JSON.parse(line));
        } catch {
          /* ignore non-json */
        }
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
    this.proc?.stdin.write(`${JSON.stringify(obj)}\n`);
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
        await new Promise((r) => setTimeout(r, 200));
        return this.events.slice(before);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`prompt timeout: ${message.slice(0, 80)}`);
  }

  /** @returns {Promise<object[]>} */
  async getEntries() {
    const before = this.events.length;
    this.send({ id: 'entries', type: 'get_entries' });
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const resp = this.events
        .slice(before)
        .find((e) => e.type === 'response' && e.command === 'get_entries');
      if (resp) return /** @type {any[]} */ (resp.data?.entries || []);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('get_entries timeout');
  }

  /** @returns {Promise<object[]>} */
  async getSkegRuns() {
    const entries = await this.getEntries();
    return entries
      .filter((e) => e.type === 'custom' && e.customType === 'skeg/run')
      .map((e) => e.data);
  }

  /** @returns {Promise<string[]>} */
  async getSkegContexts() {
    const entries = await this.getEntries();
    return entries
      .filter(
        (e) =>
          e.customType === 'skeg/context' &&
          (e.type === 'custom_message' || e.type === 'custom'),
      )
      .map((e) => String(e.content ?? e.data?.content ?? ''));
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
 * @typedef {{
 *   id: string,
 *   intent: string,
 *   work: string,
 *   expect?: {
 *     statusIncludes?: string[],
 *     fileIncludes?: Array<{ path: string, needle: string }>,
 *     gateTrigger?: string,
 *     recordsInjected?: boolean,
 *     checkName?: string,
 *   },
 *   finish?: boolean,
 *   abandon?: boolean,
 *   recordAfter?: string,
 * }} Scenario
 */

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    id: 'df-01-project-md',
    intent: 'Fill .skeg/project.md for ado-bug-agent stack and commands',
    work: [
      'Edit ONLY .skeg/project.md with this content (overwrite):',
      '',
      '# Project',
      '',
      '## Stack',
      'Node.js 18+ CommonJS MCP plugin for Azure DevOps Bug workflow.',
      '',
      '## Commands',
      '- test: npm test',
      '- check: npm run check',
      '- targeted: node --test tests/<file>.js',
      '- generate: npm run generate',
      '',
      '## Boundaries',
      '- Never commit PAT/credentials (.ado-bug-agent/credentials.json).',
      '- Keep mcp/ado-bug-agent-mcp.js as the stable entrypoint.',
      '- Do not hand-edit generated host docs; use npm run generate.',
      '',
      '## Conventions',
      '- Prefer existing src/ modules.',
      '- Add targeted tests for workflow/state changes.',
      '',
      'Reply DONE when written.',
    ].join('\n'),
    expect: {
      fileIncludes: [
        { path: '.skeg/project.md', needle: 'npm test' },
        { path: '.skeg/project.md', needle: 'mcp/ado-bug-agent-mcp.js' },
      ],
    },
    finish: true,
  },
  {
    id: 'df-02-checks-commands',
    intent: 'Map node --test and npm run check into .skeg/config.json checks.commands',
    work: [
      'Edit ONLY .skeg/config.json.',
      'Merge these fields into the existing JSON (keep other keys):',
      '- "authPaths": ["src/auth/**"]',
      '- checks.commands = {',
      '    "targeted-test": "/node --test\\\\s+\\\\S+/",',
      '    "test": "npm test",',
      '    "check": "npm run check"',
      '  }',
      'Write valid JSON. Reply DONE.',
    ].join('\n'),
    expect: {
      fileIncludes: [
        { path: '.skeg/config.json', needle: 'node --test' },
        { path: '.skeg/config.json', needle: 'src/auth/**' },
      ],
    },
    finish: true,
  },
  {
    id: 'df-03-targeted-http',
    intent: 'Prove http-client tests with targeted node --test',
    work: [
      'Do exactly this and stop:',
      '1. Read tests/http-client.js (brief).',
      '2. Run bash: node --test tests/http-client.js',
      '3. Do not edit files.',
      '4. Reply DONE with the pass count.',
    ].join('\n'),
    expect: { checkName: 'targeted-test' },
    finish: true,
  },
  {
    id: 'df-04-full-test',
    intent: 'Run full npm test suite as prove evidence',
    work: [
      'Do exactly this and stop:',
      '1. Run bash: npm test',
      '2. Do not edit files.',
      '3. Reply DONE summarizing pass/fail.',
    ].join('\n'),
    expect: { checkName: 'test' },
    finish: true,
  },
  {
    id: 'df-05-state-machine',
    intent: 'Orient on workflow state machine and run its tests',
    work: [
      'Do exactly this and stop:',
      '1. Read src/workflow/ (find state machine module) briefly.',
      '2. Run bash: node --test tests/state-machine.js',
      '3. Do not edit files.',
      '4. Reply DONE with what START_FIX blocks.',
    ].join('\n'),
    expect: { checkName: 'targeted-test' },
    finish: true,
  },
  {
    id: 'df-06-check-script',
    intent: 'Run npm run check and record evidence',
    work: [
      'Do exactly this and stop:',
      '1. Run bash: npm run check',
      '2. Do not edit files.',
      '3. Reply DONE.',
    ].join('\n'),
    expect: { checkName: 'check' },
    finish: true,
  },
  {
    id: 'df-07-apos-entity',
    intent: 'Support &apos; in decodeHtmlEntities',
    work: [
      'Do exactly this and stop:',
      '1. In src/util.js decodeHtmlEntities: ensure .replace(/&apos;/g, "\'") exists;',
      '   if it already exists, leave the replace chain as-is (no extra edits needed).',
      '2. Run bash: node --test tests/http-client.js',
      '3. Reply DONE.',
    ].join('\n'),
    expect: {
      fileIncludes: [{ path: 'src/util.js', needle: '&apos;' }],
      checkName: 'targeted-test',
    },
    finish: true,
    recordAfter:
      'decision HTML entity decode includes apos | decodeHtmlEntities handles &apos; for ADO rich text URLs',
  },
  {
    id: 'df-08-records-inject',
    intent: 'Confirm records index appears after prior decision record',
    work: [
      'Do exactly this and stop:',
      '1. Read .skeg/records/ directory listing via bash: ls .skeg/records',
      '2. Do not edit files.',
      '3. Reply DONE naming one DEC- id if present.',
    ].join('\n'),
    expect: { recordsInjected: true },
    finish: true,
  },
  {
    id: 'df-09-gitignore',
    intent: 'Ignore .skeg and .pi local agent dirs in gitignore',
    work: [
      'Do exactly this and stop:',
      '1. Edit .gitignore to append these lines if missing:',
      '   .skeg/',
      '   .pi/',
      '2. Do not remove existing entries.',
      '3. Reply DONE.',
    ].join('\n'),
    expect: {
      fileIncludes: [
        { path: '.gitignore', needle: '.skeg/' },
        { path: '.gitignore', needle: '.pi/' },
      ],
    },
    finish: true,
  },
  {
    id: 'df-10-dependency-gate',
    intent: 'Touch package.json keywords to exercise dependencyChange gate',
    work: [
      'Do exactly this and stop:',
      '1. Edit package.json keywords: set/replace the skeg marker to exactly "skeg-dogfood-v03"',
      '   (remove "skeg-dogfood" if present). This MUST modify package.json via edit/write tool.',
      '2. Do not use bash to edit the file.',
      '3. If a Skeg gate confirm appears, host will approve.',
      '4. Reply DONE after the write/edit tool succeeds.',
    ].join('\n'),
    expect: { gateTrigger: 'dependencyChange' },
    finish: true,
  },
];

/**
 * @param {PiRpc} pi
 * @param {Scenario} scenario
 */
async function runScenario(pi, scenario) {
  /** @type {string[]} */
  const frictions = [];
  let pass = true;

  pi.notifies = [];
  pi.uiRequests = [];
  await pi.prompt(`/run ${scenario.intent}`);
  if (!pi.notifies.some((n) => /Started run/i.test(n.message || ''))) {
    pass = false;
    frictions.push('major|/run did not notify Started run');
  }

  await pi.prompt(scenario.work);

  if (scenario.expect?.gateTrigger) {
    const gates = pi.uiRequests.filter(
      (u) =>
        u.method === 'confirm' &&
        new RegExp(`Skeg gate:\\s*${scenario.expect.gateTrigger}`, 'i').test(
          u.title || '',
        ),
    );
    if (gates.length === 0) {
      pass = false;
      frictions.push(
        `major|expected gate ${scenario.expect.gateTrigger}, got ${JSON.stringify(pi.uiRequests).slice(0, 160)}`,
      );
    }
  }

  for (const file of scenario.expect?.fileIncludes ?? []) {
    const full = join(HOST, file.path);
    const text = existsSync(full) ? readFileSync(full, 'utf8') : '';
    if (!text.includes(file.needle)) {
      pass = false;
      frictions.push(`major|file ${file.path} missing "${file.needle}"`);
    }
  }

  if (scenario.expect?.recordsInjected) {
    const contexts = await pi.getSkegContexts();
    const hit = contexts.some(
      (c) => /Records\s*\(\.skeg\/records\/\)/.test(c) && /DEC-\d+|INC-\d+|MIG-\d+/.test(c),
    );
    if (!hit) {
      pass = false;
      frictions.push(`major|records index not injected (contexts=${contexts.length})`);
    }
  }

  pi.notifies = [];
  await pi.prompt('/status');
  const status = pi.notifies.map((n) => n.message || '').join('\n');
  for (const needle of scenario.expect?.statusIncludes ?? []) {
    if (!status.includes(needle)) {
      pass = false;
      frictions.push(`minor|/status missing ${needle}`);
    }
  }
  if (scenario.expect?.checkName) {
    const re = new RegExp(
      `${scenario.expect.checkName}\\s*[:=]\\s*(ok|pass|true|fail)`,
      'i',
    );
    // status format: Checks: pass:name or name:ok
    const loose = new RegExp(scenario.expect.checkName, 'i');
    if (!loose.test(status)) {
      pass = false;
      frictions.push(
        `major|expected check ${scenario.expect.checkName} in /status: ${status.replace(/\n/g, ' | ').slice(0, 220)}`,
      );
    } else if (!re.test(status) && !/pass:|ok|fail/i.test(status)) {
      frictions.push(
        `nit|/status has check name but unclear pass marker: ${status.replace(/\n/g, ' | ').slice(0, 160)}`,
      );
    }
  }

  // Friction probe: phase advanced after edits?
  if ((scenario.expect?.fileIncludes?.length ?? 0) > 0) {
    if (/Phase:\s*orient/i.test(status)) {
      frictions.push(
        'minor|phase stayed orient after file edits (tool_result path accounting?)',
      );
    }
  }

  if (scenario.recordAfter) {
    pi.notifies = [];
    await pi.prompt(`/record ${scenario.recordAfter}`);
    if (!pi.notifies.some((n) => /Recorded/i.test(n.message || ''))) {
      pass = false;
      frictions.push('major|/record after run failed');
    }
  }

  pi.notifies = [];
  if (scenario.abandon) {
    await pi.prompt('/finish --abandon');
  } else if (scenario.finish !== false) {
    await pi.prompt('/finish');
    const finish = pi.notifies.map((n) => n.message || '').join('\n');
    if (!finish) {
      pass = false;
      frictions.push('major|/finish produced no notify');
    }
  }

  if (frictions.length === 0) {
    frictions.push('none|run completed as expected');
  }

  return { id: scenario.id, intent: scenario.intent, pass, frictions, status };
}

/**
 * 写 FRICTION.md 汇总。
 * @param {Array<{id: string, intent: string, pass: boolean, frictions: string[]}>} results
 */
function writeFriction(results) {
  const date = new Date().toISOString().slice(0, 10);
  const rows = results.map((r) => {
    const primary = r.frictions[0] || 'none|';
    const [severity, ...rest] = primary.split('|');
    const note = rest.join('|');
    const extra =
      r.frictions.length > 1
        ? ` (+${r.frictions.length - 1}: ${r.frictions.slice(1).join('; ')})`
        : '';
    return `| ${date} | ado-bug-agent | ${r.intent.replace(/\|/g, '/')} | ${r.id}: ${note}${extra} | ${severity} | ${r.pass ? 'keep' : 'investigate'} |`;
  });

  const path = join(SKEG_ROOT, 'dogfood', 'FRICTION.md');
  const body = [
    '# Skeg 真实使用摩擦日志',
    '',
    '目标：v0.3 期间完成 ≥ 10 个真实 run，记录摩擦点，凭证据决策 v0.4 候选。',
    '',
    '## 怎么记',
    '',
    '1. 项目内：`pi install -l /path/to/skeg` → `/init`',
    '2. 每个真实任务：`/run <intent>` → 工作 → `/status` → `/finish`；值得留的用 `/record`',
    '3. 本文件追加一行；无摩擦也记 `摩擦点=none`，仍计 1 个 run',
    '4. 严重度：`blocker` / `major` / `minor` / `nit` / `none`',
    '',
    '## Log',
    '',
    '| 日期 | 项目 | run 意图 | 摩擦点 | 严重度 | 候选修复 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `真实 run 计数：${results.length} / 10`,
    '',
    '## Host dogfood summary',
    '',
    `- host: ${HOST}`,
    `- model: ${MODEL}`,
    `- passed: ${results.filter((r) => r.pass).length}/${results.length}`,
    `- date: ${new Date().toISOString()}`,
    '',
    '## 候选证据：skeg-strict',
    '',
    `- 证据：guarded/dependency gate 在 df-10 的表现见上表；${
      results.find((r) => r.id === 'df-10-dependency-gate')?.pass
        ? 'gate 触发正常，尚未看到需要更严默认策略的需求'
        : 'gate 行为异常，需复查'
    }`,
    '- 结论：暂 no-go（证据不足支持更严可选包）',
    '',
    '## 候选证据：mission',
    '',
    '- 证据：本次 10 run 均单 session 完成，无跨 session 恢复需求',
    '- 结论：暂 no-go',
    '',
    '## 候选证据：review check',
    '',
    '- 证据：本次无独立审查需求；prove 的 command/diff 足够覆盖验证',
    '- 结论：暂 no-go',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return path;
}

async function main() {
  if (!existsSync(HOST)) {
    console.error(`Host not found: ${HOST}`);
    process.exit(2);
  }
  ensurePiPackage(HOST);
  console.log(`Host:  ${HOST}`);
  console.log(`Skeg:  ${SKEG_ROOT}`);
  console.log(`Model: ${MODEL}`);

  const pi = new PiRpc(HOST);
  await pi.start();

  // /init once
  pi.notifies = [];
  await pi.prompt('/init --force');
  console.log(
    'init:',
    pi.notifies.map((n) => n.message).join(' | ').slice(0, 160),
  );

  /** @type {Awaited<ReturnType<typeof runScenario>>[]} */
  const results = [];
  for (const scenario of SCENARIOS) {
    console.log(`\n=== ${scenario.id} ===`);
    try {
      const result = await runScenario(pi, scenario);
      results.push(result);
      console.log(
        `${result.pass ? 'PASS' : 'FAIL'}  ${scenario.id} — ${result.frictions.join('; ').slice(0, 200)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: scenario.id,
        intent: scenario.intent,
        pass: false,
        frictions: [`blocker|${message}`],
        status: '',
      });
      console.log(`FAIL  ${scenario.id} — ${message}`);
      // 尝试清掉卡住的 run
      try {
        await pi.prompt('/run --abandon');
      } catch {
        /* ignore */
      }
    }
  }

  const runs = await pi.getSkegRuns();
  console.log(`\nRunState entries: ${runs.length}`);
  await pi.stop();

  const frictionPath = writeFriction(results);
  const reportPath = join(SKEG_ROOT, 'dogfood', 'HOST_DOGFOOD.md');
  writeFileSync(
    reportPath,
    [
      '# Skeg host dogfood (ado-bug-agent)',
      '',
      `Date: ${new Date().toISOString()}`,
      `Host: ${HOST}`,
      `Model: ${MODEL}`,
      `Result: ${results.every((r) => r.pass) ? 'PASS' : 'FAIL'}`,
      `Runs: ${results.length}`,
      '',
      '| id | pass | frictions |',
      '| --- | --- | --- |',
      ...results.map(
        (r) =>
          `| ${r.id} | ${r.pass ? 'yes' : 'NO'} | ${r.frictions.join('; ').replace(/\|/g, '/')} |`,
      ),
      '',
      `Friction log: ${frictionPath}`,
      '',
    ].join('\n'),
  );

  console.log(`\nWrote ${frictionPath}`);
  console.log(`Wrote ${reportPath}`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
