/**
 * 有机（非固定 13 场景）真实 run：按项目跑一组自由意图，追加 FRICTION.md Organic 段。
 *
 * 用法：
 *   node dogfood/organic-runs.mjs --cwd . --name skeg
 *   node dogfood/organic-runs.mjs --cwd D:/Personal/ai-novels-factory --name ai-novels-factory
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKEG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

/**
 * @param {string} flag
 * @returns {string | undefined}
 */
function flagValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const cwdArg = flagValue('--cwd');
if (!cwdArg) {
  console.error(
    'Usage: node dogfood/organic-runs.mjs --cwd <project> [--name <label>]',
  );
  process.exit(2);
}

const HOST = resolve(cwdArg);
const HOST_NAME = flagValue('--name') || basename(HOST);
const TIMEOUT_MS = 180_000;
const MODEL = process.env.SKEG_SMOKE_MODEL || 'deepseek/deepseek-v4-flash';

/** @typedef {{ id: string, intent: string, work: string, finish?: boolean, abandon?: boolean, recordAfter?: string }} OrganicTask */

/**
 * 按宿主选择有机任务（非 host-dogfood 固定模板）。
 * @param {string} name
 * @returns {OrganicTask[]}
 */
function tasksFor(name) {
  if (name === 'skeg') {
    return [
      {
        id: 'org-01',
        intent: 'Record the hasCliFlag word-boundary lesson for --force/--abandon',
        work: [
          'Do exactly this and stop:',
          '1. Read src/run.ts hasCliFlag briefly.',
          '2. Do not edit production code.',
          '3. Reply with one sentence summarizing why \\b--flag fails.',
        ].join('\n'),
        recordAfter:
          'incident CLI flag word boundary | hasCliFlag replaces \\b--flag because -- has no word boundary',
        finish: true,
      },
      {
        id: 'org-02',
        intent: 'Orient on host dogfood scenario coverage for abandon/protected/auth',
        work: [
          'Do exactly this and stop:',
          '1. Read dogfood/host-dogfood.mjs buildScenarios ids df-11 df-12 df-13 briefly.',
          '2. Do not edit files.',
          '3. Reply naming the three new scenario ids.',
        ].join('\n'),
        finish: true,
      },
      {
        id: 'org-03',
        intent: 'Prove skeg with targeted paths test after organic orient',
        work: [
          'Do exactly this and stop:',
          '1. Run bash: node --experimental-strip-types --test src/run.test.ts',
          '2. Do not edit files.',
          '3. Reply DONE with pass count.',
        ].join('\n'),
        finish: true,
      },
      {
        id: 'org-04',
        intent: 'Draft a one-line STATUS note into dogfood/HOST_SCRATCH.md',
        work: [
          'Do exactly this and stop:',
          '1. Write/overwrite dogfood/HOST_SCRATCH.md with:',
          '   # organic',
          '   skeg-organic-v032',
          '2. Run bash: node --experimental-strip-types --test src/paths.test.ts',
          '3. Reply DONE.',
        ].join('\n'),
        finish: true,
      },
      {
        id: 'org-05',
        intent: 'Abandon a scratch orient that we decide not to pursue',
        work: [
          'Do exactly this and stop:',
          '1. Do not edit files.',
          '2. Reply READY TO ABANDON.',
        ].join('\n'),
        abandon: true,
      },
      {
        id: 'org-06',
        intent: 'Confirm /status shows no open run after prior abandon',
        work: [
          'Do exactly this and stop:',
          '1. Do not edit files.',
          '2. Reply with whether an active run exists based on injected Skeg context.',
        ].join('\n'),
        finish: true,
      },
    ];
  }

  // ai-novels-factory and generic hosts
  return [
    {
      id: 'org-01',
      intent: `Fill .skeg/project.md with a short Stack/Commands sketch for ${name}`,
      work: [
        'Do exactly this and stop:',
        '1. Write/overwrite .skeg/project.md with a short Project note covering Stack and Commands only (≤ 40 lines).',
        '2. Prefer real commands if README/package scripts are obvious; otherwise write placeholders.',
        '3. Reply DONE.',
      ].join('\n'),
      finish: true,
    },
    {
      id: 'org-02',
      intent: `Map a minimal checks.commands stub into .skeg/config.json for ${name}`,
      work: [
        'Do exactly this and stop:',
        '1. Edit .skeg/config.json: ensure checks.commands has at least one entry (e.g. "test": "npm test" or a plausible command).',
        '2. Keep valid JSON. Reply DONE.',
      ].join('\n'),
      finish: true,
    },
    {
      id: 'org-03',
      intent: `Orient on the repo root layout for ${name}`,
      work: [
        'Do exactly this and stop:',
        '1. List top-level dirs via bash: ls',
        '2. Do not edit files.',
        '3. Reply DONE naming 3 top-level entries.',
      ].join('\n'),
      finish: true,
    },
    {
      id: 'org-04',
      intent: `Write an organic scratch note under .skeg-dogfood/ for ${name}`,
      work: [
        'Do exactly this and stop:',
        '1. Write/overwrite .skeg-dogfood/organic.md with two lines:',
        '   # organic',
        `   ${name}-organic-v032`,
        '2. Reply DONE.',
      ].join('\n'),
      recordAfter: `incident organic scratch for ${name} | .skeg-dogfood/organic.md marker for skeg dogfood`,
      finish: true,
    },
    {
      id: 'org-05',
      intent: `Abandon a non-goal exploration on ${name}`,
      work: [
        'Do exactly this and stop:',
        '1. Do not edit files.',
        '2. Reply READY TO ABANDON.',
      ].join('\n'),
      abandon: true,
    },
    {
      id: 'org-06',
      intent: `Ignore local agent dirs in gitignore for ${name}`,
      work: [
        'Do exactly this and stop:',
        '1. Edit .gitignore to append if missing:',
        '   .skeg/',
        '   .pi/',
        '   .skeg-dogfood/',
        '2. Reply DONE.',
      ].join('\n'),
      finish: true,
    },
  ];
}

/**
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
    /** @type {any[]} */
    this.events = [];
    /** @type {Array<{message?: string}>} */
    this.notifies = [];
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
        'skeg-organic',
      ],
      { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
    );
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
          /* ignore */
        }
      }
    });
    await new Promise((r) => setTimeout(r, 800));
    if (this.proc.exitCode !== null) {
      throw new Error(`pi exited early: code=${this.proc.exitCode}`);
    }
  }

  /** @param {any} msg */
  handle(msg) {
    this.events.push(msg);
    if (msg.type === 'extension_ui_request') {
      const method = String(msg.method || '');
      if (method === 'notify') {
        this.notifies.push({ message: String(msg.message || '') });
      } else if (method === 'confirm' && this.autoConfirm) {
        this.send({
          type: 'extension_ui_response',
          id: msg.id,
          confirmed: true,
        });
      } else if (method === 'select') {
        const opts = /** @type {string[]} */ (msg.options || []);
        this.send({
          type: 'extension_ui_response',
          id: msg.id,
          value: opts[0],
        });
      } else if (method === 'confirm') {
        this.send({
          type: 'extension_ui_response',
          id: msg.id,
          confirmed: false,
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
      if (slice.some((e) => e.type === 'agent_settled' || e.type === 'agent_end')) {
        return slice;
      }
      const resp = slice.find(
        (e) => e.type === 'response' && e.command === 'prompt',
      );
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
 * @param {PiRpc} pi
 * @param {OrganicTask} task
 */
async function runTask(pi, task) {
  /** @type {string[]} */
  const frictions = [];
  let pass = true;

  pi.notifies = [];
  await pi.prompt(`/run ${task.intent}`);
  if (!pi.notifies.some((n) => /Started run/i.test(n.message || ''))) {
    pass = false;
    frictions.push('major|/run did not notify Started run');
  }

  await pi.prompt(task.work);

  pi.notifies = [];
  await pi.prompt('/status');
  const status = pi.notifies.map((n) => n.message || '').join('\n');
  if (!/Intent:/i.test(status)) {
    pass = false;
    frictions.push('minor|/status missing Intent');
  }

  if (task.recordAfter) {
    pi.notifies = [];
    await pi.prompt(`/record ${task.recordAfter}`);
    if (!pi.notifies.some((n) => /Recorded/i.test(n.message || ''))) {
      pass = false;
      frictions.push('major|/record failed');
    }
  }

  pi.notifies = [];
  if (task.abandon) {
    await pi.prompt('/finish --abandon');
    if (!pi.notifies.some((n) => /Abandoned/i.test(n.message || ''))) {
      pass = false;
      frictions.push('major|/finish --abandon failed');
    }
  } else if (task.finish !== false) {
    await pi.prompt('/finish');
    if (!pi.notifies.some((n) => n.message)) {
      pass = false;
      frictions.push('major|/finish produced no notify');
    }
  }

  if (frictions.length === 0) frictions.push('none|organic run completed');
  return { id: task.id, intent: task.intent, pass, frictions, status };
}

/**
 * @param {Array<{id: string, intent: string, pass: boolean, frictions: string[]}>} results
 * @param {string} hostName
 */
function appendOrganic(results, hostName) {
  const date = new Date().toISOString().slice(0, 10);
  const path = join(SKEG_ROOT, 'dogfood', 'FRICTION.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prior = (existing.match(/^## Organic \d+/gm) || []).length;
  const round = prior + 1;
  const rows = results.map((r) => {
    const primary = r.frictions[0] || 'none|';
    const [severity, ...rest] = primary.split('|');
    return `| ${date} | ${hostName} | ${r.intent.replace(/\|/g, '/')} | ${r.id}: ${rest.join('|')} | ${severity} | ${r.pass ? 'keep' : 'investigate'} |`;
  });
  const section = [
    `## Organic ${round}（${hostName}，${date}）`,
    '',
    '| 日期 | 项目 | run 意图 | 摩擦点 | 严重度 | 候选修复 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `有机 run 计数：${results.length}`,
    `- model: ${MODEL}`,
    `- passed: ${results.filter((r) => r.pass).length}/${results.length}`,
    `- date: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  writeFileSync(path, `${existing.trimEnd()}\n\n${section}`, 'utf8');
  return path;
}

async function main() {
  if (!existsSync(HOST)) {
    console.error(`Host not found: ${HOST}`);
    process.exit(2);
  }
  ensurePiPackage(HOST);
  const tasks = tasksFor(HOST_NAME);
  console.log(`Organic host: ${HOST} (${HOST_NAME})`);
  console.log(`Tasks: ${tasks.length}`);

  const pi = new PiRpc(HOST);
  await pi.start();
  pi.notifies = [];
  await pi.prompt('/init');
  console.log('init:', pi.notifies.map((n) => n.message).join(' | ').slice(0, 160));

  /** @type {Awaited<ReturnType<typeof runTask>>[]} */
  const results = [];
  for (const task of tasks) {
    console.log(`\n=== ${task.id} ===`);
    try {
      const result = await runTask(pi, task);
      results.push(result);
      console.log(
        `${result.pass ? 'PASS' : 'FAIL'}  ${task.id} — ${result.frictions.join('; ').slice(0, 200)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: task.id,
        intent: task.intent,
        pass: false,
        frictions: [`blocker|${message}`],
        status: '',
      });
      console.log(`FAIL  ${task.id} — ${message}`);
      try {
        await pi.prompt('/run --abandon');
      } catch {
        /* ignore */
      }
    }
  }

  await pi.stop();
  const written = appendOrganic(results, HOST_NAME);
  console.log(`\nAppended organic → ${written}`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
