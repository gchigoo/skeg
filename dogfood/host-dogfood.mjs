/**
 * 真实宿主 dogfood：按 profile 在指定项目 cwd 上跑 ≥10 个 Skeg run，追加 FRICTION.md。
 *
 * 用法：
 *   node dogfood/host-dogfood.mjs --cwd D:/Projects/ado-bug-agent
 *   node dogfood/host-dogfood.mjs --cwd . --profile skeg
 *   node dogfood/host-dogfood.mjs --cwd <project> --profile ./dogfood/profiles/custom.json
 *   node dogfood/host-dogfood.mjs --cwd D:/Personal/Blog --profile Blog
 *   node dogfood/host-dogfood.mjs --cwd . --profile skeg --dump-events
 *   node dogfood/host-dogfood.mjs --cwd . --profile skeg --repeat 3 --dump-events
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

/**
 * @param {string} flag
 * @returns {boolean}
 */
function hasFlag(flag) {
  return args.includes(flag);
}

const cwdArg = flagValue('--cwd');
if (!cwdArg) {
  console.error(
    'Usage: node dogfood/host-dogfood.mjs --cwd <project> [--profile <name|path>] [--dump-events] [--repeat N]',
  );
  process.exit(2);
}
const HOST = resolve(cwdArg);
const TIMEOUT_MS = 180_000;
const MODEL = process.env.SKEG_SMOKE_MODEL || 'deepseek/deepseek-v4-flash';
const DUMP_EVENTS = hasFlag('--dump-events');
const REPEAT = Math.max(1, Number.parseInt(flagValue('--repeat') || '1', 10) || 1);
const EVENTS_DIR = join(SKEG_ROOT, 'dogfood', 'events');

/**
 * 将 profile 中的 {{marker}} 替换为每轮唯一 token。
 * @param {unknown} value
 * @param {string} marker
 * @returns {unknown}
 */
function applyMarker(value, marker) {
  if (Array.isArray(value)) return value.map((v) => applyMarker(v, marker));
  if (typeof value === 'string') return value.split('{{marker}}').join(marker);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyMarker(v, marker);
    }
    return out;
  }
  return value;
}

/**
 * 确保字符串含本轮 marker（无 {{marker}} 模板时追加一行）。
 * @param {string} text
 * @param {string} marker
 * @returns {string}
 */
function ensureMarker(text, marker) {
  if (text.includes(marker)) return text;
  if (text.includes('{{marker}}')) return applyMarker(text, marker);
  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}\nSKEG_MARKER=${marker}\n`;
}

/**
 * 解析 profile 路径：名称 → dogfood/profiles/<name>.json，或绝对/相对路径。
 * @param {string | undefined} raw
 * @param {string} host
 * @returns {string}
 */
function resolveProfilePath(raw, host) {
  if (raw) {
    if (existsSync(raw)) return resolve(raw);
    const named = join(SKEG_ROOT, 'dogfood', 'profiles', `${raw}.json`);
    if (existsSync(named)) return named;
    throw new Error(`Profile not found: ${raw}`);
  }
  // 默认：按宿主目录名匹配，否则 generic 失败提示
  const guess = basename(host);
  const named = join(SKEG_ROOT, 'dogfood', 'profiles', `${guess}.json`);
  if (existsSync(named)) return named;
  throw new Error(
    `No --profile and no dogfood/profiles/${guess}.json; pass --profile <name|path>`,
  );
}

const PROFILE_PATH = resolveProfilePath(flagValue('--profile'), HOST);
/** @type {any} */
const PROFILE = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));

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
 *     phaseNotOrient?: boolean,
 *     abandoned?: boolean,
 *     riskGuarded?: boolean,
 *   },
 *   finish?: boolean,
 *   abandon?: boolean,
 *   recordAfter?: string,
 * }} Scenario
 */

/**
 * 从 profile 构建通用 10 场景集。
 * @param {any} profile
 * @returns {Scenario[]}
 */
function buildScenarios(profile) {
  const projectMd = Array.isArray(profile.projectMd)
    ? profile.projectMd.join('\n')
    : String(profile.projectMd || '');
  const checksJson = JSON.stringify(profile.checksCommands || {}, null, 2);
  const authPaths = JSON.stringify(profile.authPaths || []);
  const gitignoreLines = (profile.gitignoreEntries || ['.skeg/', '.pi/']).join(
    '\n   ',
  );
  // 每次跑用唯一 marker，避免上次残留导致 agent 跳过 edit、gate 不触发
  const marker = `${profile.dependencyMarker || 'skeg-dogfood'}-${Date.now().toString(36)}`;
  /** @type {any} */
  const editRaw = profile.edit || {};
  /** @type {any} */
  const edit = applyMarker(
    {
      ...editRaw,
      needle: editRaw.needle || '{{marker}}',
      work: editRaw.work,
    },
    marker,
  );
  if (typeof edit.needle === 'string' && !edit.needle.includes(marker)) {
    edit.needle = marker;
  }
  /** @type {any} */
  const protectedRaw = profile.protectedTouch || {
    path: '.env.skeg-dogfood',
    content: 'SKEG_DOGFOOD={{marker}}\n',
  };
  const protectedTouch = {
    path: protectedRaw.path || '.env.skeg-dogfood',
    content: ensureMarker(
      String(protectedRaw.content || 'SKEG_DOGFOOD={{marker}}\n'),
      marker,
    ),
  };
  /** @type {any} */
  const authRaw = profile.authEdit || {
    path: '.skeg-dogfood/auth-scratch.js',
    needle: '{{marker}}',
    work: [
      'Do exactly this and stop:',
      '1. Write/overwrite .skeg-dogfood/auth-scratch.js with exactly:',
      '   // {{marker}}',
      "   export const marker = '{{marker}}';",
      '2. Do not edit other files.',
      '3. If a Skeg gate confirm appears, host will approve.',
      '4. Reply DONE after the write/edit tool succeeds.',
    ],
  };
  const authEdit = /** @type {any} */ (applyMarker(authRaw, marker));
  if (typeof authEdit.needle === 'string' && !String(authEdit.needle).includes(marker)) {
    authEdit.needle = marker;
  }
  // 强制每轮写入：去掉「已存在则跳过」类措辞，避免静态残留导致 gate 漏触发
  if (Array.isArray(authEdit.work)) {
    authEdit.work = authEdit.work.map((line) =>
      String(line).replace(
        /If that line already exists[^.]*\./gi,
        'You MUST perform a real write/edit even if a similar marker exists.',
      ),
    );
  }

  return [
    {
      id: 'df-01-project-md',
      intent: `Fill .skeg/project.md for ${profile.name} stack and commands`,
      work: [
        'Edit ONLY .skeg/project.md with this content (overwrite):',
        '',
        projectMd,
        '',
        'Reply DONE when written.',
      ].join('\n'),
      expect: {
        fileIncludes: [
          { path: '.skeg/project.md', needle: profile.fullTest || 'npm test' },
        ],
        phaseNotOrient: true,
      },
      finish: true,
    },
    {
      id: 'df-02-checks-commands',
      intent: `Map checks.commands into .skeg/config.json for ${profile.name}`,
      work: [
        'Edit ONLY .skeg/config.json.',
        'Merge these fields into the existing JSON (keep other keys):',
        `- "authPaths": ${authPaths}`,
        `- checks.commands = ${checksJson}`,
        'Write valid JSON. Reply DONE.',
      ].join('\n'),
      expect: {
        fileIncludes: [
          { path: '.skeg/config.json', needle: 'checks' },
          {
            path: '.skeg/config.json',
            needle: Object.keys(profile.checksCommands || {})[0] || 'test',
          },
        ],
        phaseNotOrient: true,
      },
      finish: true,
    },
    {
      id: 'df-03-targeted',
      intent: `Prove with targeted test: ${profile.targetedTest}`,
      work: [
        'Do exactly this and stop:',
        `1. You MUST invoke the bash tool with exactly: ${profile.targetedTest}`,
        '2. Wait for the bash tool result. Do not skip the tool call.',
        '3. Do not edit files.',
        '4. Reply DONE with the pass count only after bash completes.',
      ].join('\n'),
      expect: { checkName: 'targeted-test' },
      finish: true,
    },
    {
      id: 'df-04-full-test',
      intent: `Run full test suite: ${profile.fullTest}`,
      work: [
        'Do exactly this and stop:',
        `1. You MUST invoke the bash tool with exactly: ${profile.fullTest}`,
        '2. Wait for the bash tool result. Do not skip the tool call.',
        '3. Do not edit files.',
        '4. Reply DONE summarizing pass/fail only after bash completes.',
      ].join('\n'),
      expect: { checkName: 'test' },
      finish: true,
    },
    {
      id: 'df-05-orient-module',
      intent: `Orient on ${profile.orientRead} and run its tests`,
      work: [
        'Do exactly this and stop:',
        `1. Read ${profile.orientRead} briefly.`,
        `2. You MUST invoke the bash tool with exactly: ${profile.orientTest}`,
        '3. Wait for the bash tool result. Do not skip the tool call.',
        '4. Do not edit files.',
        '5. Reply DONE only after bash completes.',
      ].join('\n'),
      expect: { checkName: 'targeted-test' },
      finish: true,
    },
    {
      id: 'df-06-check-script',
      intent: `Run ${profile.checkScript} and record evidence`,
      work: [
        'Do exactly this and stop:',
        `1. You MUST invoke the bash tool with exactly: ${profile.checkScript}`,
        '2. Wait for the bash tool result. Do not skip the tool call.',
        '3. Do not edit files.',
        '4. Reply DONE only after bash completes.',
      ].join('\n'),
      expect: {
        checkName:
          Object.keys(profile.checksCommands || {}).find((k) =>
            String(profile.checksCommands[k]).includes(
              String(profile.checkScript).split(' ').slice(-1)[0],
            ),
          ) || 'typecheck',
      },
      finish: true,
    },
    {
      id: 'df-07-edit-and-test',
      intent: `Edit ${edit.path || 'a source file'} and prove with targeted test`,
      work: [
        Array.isArray(edit.work)
          ? edit.work.join('\n')
          : String(edit.work || 'Reply DONE.'),
        '',
        'Hard rules:',
        `- The written content MUST include the unique marker: ${marker}`,
        '- You MUST run the targeted bash test via the bash tool and wait for its result.',
        '- Do not skip write/edit or bash.',
      ].join('\n'),
      expect: {
        fileIncludes: edit.path
          ? [{ path: edit.path, needle: edit.needle || marker }]
          : [],
        checkName: 'targeted-test',
        phaseNotOrient: true,
      },
      finish: true,
      recordAfter: edit.recordAfter,
    },
    {
      id: 'df-08-records-inject',
      intent: 'Confirm records index appears after prior decision/incident record',
      work: [
        'Do exactly this and stop:',
        '1. Read .skeg/records/ directory listing via bash: ls .skeg/records',
        '2. Do not edit files.',
        '3. Reply DONE naming one DEC-/INC-/MIG- id if present.',
      ].join('\n'),
      expect: { recordsInjected: true },
      finish: true,
    },
    {
      id: 'df-09-gitignore',
      intent: 'Ignore local agent dirs in gitignore',
      work: [
        'Do exactly this and stop:',
        '1. Edit .gitignore to append these lines if missing:',
        `   ${gitignoreLines}`,
        '2. Do not remove existing entries.',
        '3. Reply DONE.',
      ].join('\n'),
      expect: {
        fileIncludes: (profile.gitignoreEntries || ['.skeg/', '.pi/']).map(
          (needle) => ({ path: '.gitignore', needle }),
        ),
        phaseNotOrient: true,
      },
      finish: true,
    },
    {
      id: 'df-10-dependency-gate',
      intent: 'Touch package.json keywords to exercise dependencyChange gate',
      work: [
        'Do exactly this and stop:',
        `1. Edit package.json keywords via write/edit tool: remove every keyword matching /^skeg-dogfood/`,
        `   then append exactly "${marker}" (a fresh unique token). You MUST perform a real write even if a similar marker exists.`,
        '2. Do not use bash to edit the file.',
        '3. If a Skeg gate confirm appears, host will approve.',
        '4. Reply DONE after the write/edit tool succeeds.',
      ].join('\n'),
      expect: { gateTrigger: 'dependencyChange', phaseNotOrient: true },
      finish: true,
    },
    {
      id: 'df-11-abandon',
      intent: 'Abandon an open run without finishing prove',
      work: [
        'Do exactly this and stop:',
        '1. Do not edit files.',
        '2. Do not run tests.',
        '3. Reply READY FOR ABANDON.',
      ].join('\n'),
      expect: { abandoned: true },
      abandon: true,
      finish: false,
    },
    {
      id: 'df-12-protected-gate',
      intent: `Touch protected path ${protectedTouch.path} to exercise protectedPaths gate`,
      work: [
        'Do exactly this and stop:',
        `1. Write/overwrite ${protectedTouch.path} with exactly this content via write/edit tool (not bash):`,
        String(protectedTouch.content || 'SKEG_DOGFOOD=1\n')
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => `   ${l}`)
          .join('\n') || '   SKEG_DOGFOOD=1',
        '2. Do not use bash to edit the file.',
        '3. If a Skeg gate confirm appears, host will approve.',
        '4. Reply DONE after the write/edit tool succeeds.',
      ].join('\n'),
      expect: {
        gateTrigger: 'protectedPaths',
        fileIncludes: [
          {
            path: protectedTouch.path,
            needle: (protectedTouch.content || 'SKEG_DOGFOOD').split('\n')[0],
          },
        ],
        phaseNotOrient: true,
      },
      finish: true,
    },
    {
      id: 'df-13-auth-guarded',
      intent: `Edit auth path ${authEdit.path} to exercise authChange gate`,
      work: Array.isArray(authEdit.work)
        ? authEdit.work.join('\n')
        : String(authEdit.work || 'Reply DONE.'),
      expect: {
        gateTrigger: 'authChange',
        fileIncludes: authEdit.path
          ? [{ path: authEdit.path, needle: authEdit.needle || '' }]
          : [],
        phaseNotOrient: true,
        riskGuarded: true,
      },
      finish: true,
    },
  ];
}

/**
 * 将场景 RPC 事件流写入 dogfood/events/（归因用）。
 * @param {number} round
 * @param {string} scenarioId
 * @param {RpcMsg[]} events
 * @param {{ pass: boolean, frictions: string[] }} meta
 */
function dumpScenarioEvents(round, scenarioId, events, meta) {
  if (!DUMP_EVENTS) return '';
  mkdirSync(EVENTS_DIR, { recursive: true });
  const path = join(EVENTS_DIR, `r${round}-${scenarioId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'meta',
      round,
      scenarioId,
      pass: meta.pass,
      frictions: meta.frictions,
      model: MODEL,
      host: HOST,
      at: new Date().toISOString(),
    }),
    ...events.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

/**
 * @param {PiRpc} pi
 * @param {Scenario} scenario
 * @param {number} [round]
 */
async function runScenario(pi, scenario, round = 0) {
  /** @type {string[]} */
  const frictions = [];
  let pass = true;
  const eventStart = pi.events.length;

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
    if (!file.needle) continue;
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
      (c) =>
        /Records\s*\(\.skeg\/records\/\)/.test(c) &&
        /DEC-\d+|INC-\d+|MIG-\d+/.test(c),
    );
    if (!hit) {
      pass = false;
      frictions.push(
        `major|records index not injected (contexts=${contexts.length})`,
      );
    }
  }

  pi.notifies = [];
  await pi.prompt('/status');
  let status = pi.notifies.map((n) => n.message || '').join('\n');
  for (const needle of scenario.expect?.statusIncludes ?? []) {
    if (!status.includes(needle)) {
      pass = false;
      frictions.push(`minor|/status missing ${needle}`);
    }
  }
  if (scenario.expect?.checkName) {
    const loose = new RegExp(scenario.expect.checkName, 'i');
    if (!loose.test(status)) {
      pass = false;
      frictions.push(
        `major|expected check ${scenario.expect.checkName} in /status: ${status.replace(/\n/g, ' | ').slice(0, 220)}`,
      );
    }
  }
  if (scenario.expect?.riskGuarded) {
    if (!/Risk:\s*guarded/i.test(status)) {
      pass = false;
      frictions.push(
        `major|expected Risk guarded in /status: ${status.replace(/\n/g, ' | ').slice(0, 220)}`,
      );
    }
  }

  // Friction probe: phase advanced after edits?
  if (
    scenario.expect?.phaseNotOrient ||
    (scenario.expect?.fileIncludes?.length ?? 0) > 0
  ) {
    if (/Phase:\s*orient/i.test(status)) {
      frictions.push(
        'minor|phase stayed orient after file edits (tool_result/agent_end heal?)',
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
    const abandonMsg = pi.notifies.map((n) => n.message || '').join('\n');
    if (!/Abandoned/i.test(abandonMsg)) {
      pass = false;
      frictions.push(
        `major|/finish --abandon did not notify Abandoned: ${abandonMsg.slice(0, 160)}`,
      );
    }
    pi.notifies = [];
    await pi.prompt('/status');
    status = pi.notifies.map((n) => n.message || '').join('\n');
    if (scenario.expect?.abandoned && !/Status:\s*abandoned/i.test(status)) {
      pass = false;
      frictions.push(
        `major|expected Status abandoned after abandon: ${status.replace(/\n/g, ' | ').slice(0, 220)}`,
      );
    }
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

  const slice = pi.events.slice(eventStart);
  const dumpPath = dumpScenarioEvents(round, scenario.id, slice, {
    pass,
    frictions,
  });
  if (dumpPath && !pass) {
    console.log(`  events: ${dumpPath}`);
  }

  return {
    id: scenario.id,
    intent: scenario.intent,
    pass,
    frictions,
    status,
    dumpPath,
  };
}

/**
 * 统计已有 Round 段落数。
 * @param {string} text
 * @returns {number}
 */
function countRounds(text) {
  const a = text.match(/^## Round \d+/gm) || [];
  const b = text.match(/^## Log（Round \d+/gm) || [];
  return a.length + b.length;
}

/**
 * 追加 Round 段落到 FRICTION.md（保留历史）。
 * @param {Array<{id: string, intent: string, pass: boolean, frictions: string[]}>} results
 * @param {string} hostName
 * @param {number} round
 */
function appendFriction(results, hostName, round) {
  const date = new Date().toISOString().slice(0, 10);
  const path = join(SKEG_ROOT, 'dogfood', 'FRICTION.md');
  const header = [
    '# Skeg 真实使用摩擦日志',
    '',
    '目标：真实 run 记录摩擦点，凭证据决策后续候选。',
    '',
    '## 怎么记',
    '',
    '1. 项目内：`pi install -l /path/to/skeg` → `/init`',
    '2. 每个真实任务：`/run <intent>` → 工作 → `/status` → `/finish`；值得留的用 `/record`',
    '3. 本文件追加 Round；无摩擦也记 `摩擦点=none`，仍计 1 个 run',
    '4. 严重度：`blocker` / `major` / `minor` / `nit` / `none`',
    '5. 宿主批量：`npm run dogfood:host -- --cwd <project> [--profile <name>]`',
    '',
  ].join('\n');

  let existing = existsSync(path) ? readFileSync(path, 'utf8') : header;
  if (!existing.includes('# Skeg')) {
    existing = header + existing;
  }

  const rows = results.map((r) => {
    const primary = r.frictions[0] || 'none|';
    const [severity, ...rest] = primary.split('|');
    const note = rest.join('|');
    const extra =
      r.frictions.length > 1
        ? ` (+${r.frictions.length - 1}: ${r.frictions.slice(1).join('; ')})`
        : '';
    return `| ${date} | ${hostName} | ${r.intent.replace(/\|/g, '/')} | ${r.id}: ${note}${extra} | ${severity} | ${r.pass ? 'keep' : 'investigate'} |`;
  });

  const phaseStuck = results.filter((r) =>
    r.frictions.some((f) => /phase stayed orient/i.test(f)),
  ).length;

  const section = [
    `## Round ${round}（${hostName}，${date}）`,
    '',
    '| 日期 | 项目 | run 意图 | 摩擦点 | 严重度 | 候选修复 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `真实 run 计数：${results.length} / 13`,
    `phase stayed orient：${phaseStuck}`,
    '',
    '### Host dogfood summary',
    '',
    `- host: ${HOST}`,
    `- profile: ${PROFILE_PATH}`,
    `- model: ${MODEL}`,
    `- passed: ${results.filter((r) => r.pass).length}/${results.length}`,
    `- date: ${new Date().toISOString()}`,
    '',
    '### 候选证据快照',
    '',
    `- skeg-strict: ${
      results.find((r) => r.id === 'df-10-dependency-gate')?.pass &&
      results.find((r) => r.id === 'df-12-protected-gate')?.pass
        ? 'gate 正常；暂无更严默认策略诉求 → no-go'
        : 'gate 异常，需复查'
    }`,
    `- mission: ${
      results.find((r) => r.id === 'df-11-abandon')?.pass
        ? 'abandon 可用；仍无跨 session 恢复诉求 → no-go'
        : 'abandon 异常，需复查'
    }`,
    `- review check: ${
      results.find((r) => r.id === 'df-13-auth-guarded')?.pass
        ? 'authChange gate + guarded 升级覆盖；无独立审查诉求 → no-go'
        : 'authChange 异常，需复查'
    }`,
    '',
  ].join('\n');

  writeFileSync(path, `${existing.trimEnd()}\n\n${section}`, 'utf8');
  return path;
}

/**
 * 跑一整轮 13 场景并追加 FRICTION Round。
 * @returns {Promise<{ round: number, pass: boolean, results: Awaited<ReturnType<typeof runScenario>>[] }>}
 */
async function runOnce() {
  ensurePiPackage(HOST);
  const scenarios = buildScenarios(PROFILE);
  const frictionPath = join(SKEG_ROOT, 'dogfood', 'FRICTION.md');
  const prior = existsSync(frictionPath)
    ? readFileSync(frictionPath, 'utf8')
    : '';
  const round = countRounds(prior) + 1;

  console.log(`Host:    ${HOST}`);
  console.log(`Skeg:    ${SKEG_ROOT}`);
  console.log(`Profile: ${PROFILE_PATH}`);
  console.log(`Model:   ${MODEL}`);
  console.log(`Round:   ${round}`);
  console.log(`Dump:    ${DUMP_EVENTS ? EVENTS_DIR : 'off'}`);
  console.log(`Scenarios: ${scenarios.length} (incl. abandon/protected/auth)`);

  const pi = new PiRpc(HOST);
  await pi.start();

  pi.notifies = [];
  await pi.prompt('/init --force');
  console.log(
    'init:',
    pi.notifies.map((n) => n.message).join(' | ').slice(0, 160),
  );

  /** @type {Awaited<ReturnType<typeof runScenario>>[]} */
  const results = [];
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.id} ===`);
    try {
      const result = await runScenario(pi, scenario, round);
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

  const written = appendFriction(results, PROFILE.name || basename(HOST), round);

  const reportPath = join(SKEG_ROOT, 'dogfood', 'HOST_DOGFOOD.md');
  writeFileSync(
    reportPath,
    [
      `# Skeg host dogfood (${PROFILE.name || basename(HOST)})`,
      '',
      `Date: ${new Date().toISOString()}`,
      `Host: ${HOST}`,
      `Profile: ${PROFILE_PATH}`,
      `Model: ${MODEL}`,
      `Round: ${round}`,
      `Dump events: ${DUMP_EVENTS}`,
      `Result: ${results.every((r) => r.pass) ? 'PASS' : 'FAIL'}`,
      `Runs: ${results.length}`,
      `phase stayed orient: ${results.filter((r) => r.frictions.some((f) => /phase stayed orient/i.test(f))).length}`,
      '',
      '| id | pass | frictions |',
      '| --- | --- | --- |',
      ...results.map(
        (r) =>
          `| ${r.id} | ${r.pass ? 'yes' : 'NO'} | ${r.frictions.join('; ').replace(/\|/g, '/')} |`,
      ),
      '',
      `Friction log: ${written}`,
      '',
    ].join('\n'),
  );

  console.log(`\nAppended Round ${round} → ${written}`);
  console.log(`Wrote ${reportPath}`);
  return {
    round,
    pass: results.every((r) => r.pass),
    results,
  };
}

async function main() {
  if (!existsSync(HOST)) {
    console.error(`Host not found: ${HOST}`);
    process.exit(2);
  }

  console.log(`Repeat:  ${REPEAT}`);
  /** @type {Array<{ round: number, pass: boolean }>} */
  const summaries = [];
  for (let i = 0; i < REPEAT; i++) {
    if (REPEAT > 1) {
      console.log(`\n######## repeat ${i + 1}/${REPEAT} ########`);
    }
    const once = await runOnce();
    summaries.push({ round: once.round, pass: once.pass });
  }

  if (REPEAT > 1) {
    console.log('\n=== repeat summary ===');
    for (const s of summaries) {
      console.log(`Round ${s.round}: ${s.pass ? 'PASS' : 'FAIL'}`);
    }
    const ok = summaries.filter((s) => s.pass).length;
    console.log(`${ok}/${summaries.length} rounds passed`);
  }

  process.exit(summaries.every((s) => s.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
