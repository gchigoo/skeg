/**
 * Skeg Pi 适配层：事件钩子 + 四个核心命令。
 * 机制逻辑在 src/，本文件只做宿主桥接。
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../src/config.ts';
import { buildInjectContext } from '../src/inject.ts';
import { initSkeg } from '../src/init.ts';
import { runProveChecks } from '../src/prove.ts';
import { createRecord, parseRecordArgs } from '../src/record.ts';
import {
  detectPathRisks,
  pathsFromToolCall,
  requiresGate,
  scanToolCall,
} from '../src/risk.ts';
import {
  addChangedFiles,
  addRecordId,
  applyRiskHit,
  clearResolvedGate,
  closeRun,
  createRun,
  formatCloseReport,
  formatStatus,
  isOpenRun,
  latestRunFromEntries,
  resolveGate,
  setPhase,
} from '../src/run.ts';
import { RUN_ENTRY_TYPE, type RunState, type SkegConfig } from '../src/types.ts';

/**
 * Pi package 入口。
 * @param pi ExtensionAPI
 */
export default function (pi: ExtensionAPI) {
  let run: RunState | null = null;
  let config: SkegConfig = loadConfig(process.cwd());
  /** 本 session 已确认的 trigger:path，避免同一次迁移反复弹 gate */
  const acknowledged = new Set<string>();

  const persist = (next: RunState) => {
    run = next;
    pi.appendEntry(RUN_ENTRY_TYPE, next);
  };

  const reloadConfig = (cwd: string) => {
    config = loadConfig(cwd);
  };

  const gateKey = (trigger: string, path: string) => `${trigger}:${path}`;

  pi.on('session_start', async (_event, ctx) => {
    reloadConfig(ctx.cwd);
    run = latestRunFromEntries(ctx.sessionManager.getEntries());
  });

  pi.on('before_agent_start', async (event, ctx) => {
    reloadConfig(ctx.cwd);
    if (!run) {
      run = latestRunFromEntries(ctx.sessionManager.getEntries());
    }

    // Prompt template（如 /fix）带 <!-- skeg:run --> 时自动开跑
    const prompt = event.prompt ?? '';
    if (!isOpenRun(run) && prompt.includes('<!-- skeg:run -->')) {
      const intent = prompt
        .replace(/<!--\s*skeg:run\s*-->/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      if (intent) {
        persist(createRun(intent, config.defaultPolicy));
        acknowledged.clear();
      }
    }

    const content = buildInjectContext(run, config, ctx.cwd);
    return {
      message: {
        customType: 'skeg/context',
        content,
        display: false,
      },
    };
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!isOpenRun(run)) return undefined;

    if (run!.pendingGate?.resolved) {
      persist(clearResolvedGate(run!));
    }

    const hits = scanToolCall(
      event.toolName,
      event.input as Record<string, unknown>,
      config,
    );
    if (hits.length === 0) return undefined;

    const hit = hits[0];
    if (!requiresGate(hit.trigger)) return undefined;

    const key = gateKey(hit.trigger, hit.path || '');
    if (acknowledged.has(key)) return undefined;

    persist(applyRiskHit(run!, hit));

    const title = `Skeg gate: ${hit.trigger}`;
    const body = `${hit.reason}\n\nAllow this action and continue in guarded mode?`;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Skeg blocked (${hit.trigger}): ${hit.reason}`,
      };
    }

    const ok = await ctx.ui.confirm(title, body);
    if (!ok) {
      return {
        block: true,
        reason: `Skeg gate denied: ${hit.trigger}`,
      };
    }

    acknowledged.add(key);
    persist(resolveGate(run!));
    return undefined;
  });

  pi.on('tool_result', async (event) => {
    if (!isOpenRun(run)) return undefined;

    const tool = event.toolName.toLowerCase();
    if (tool === 'write' || tool === 'edit') {
      const paths = pathsFromToolCall(
        event.toolName,
        event.input as Record<string, unknown>,
      );
      if (paths.length > 0) {
        let next = addChangedFiles(run!, paths);
        if (next.phase === 'orient') next = setPhase(next, 'change');
        persist(next);
      }
    }

    // bash 成功且涉及风险路径时也记账
    if (tool === 'bash' && !event.isError) {
      const paths = pathsFromToolCall(
        event.toolName,
        event.input as Record<string, unknown>,
      );
      const risky = paths.flatMap((p) => detectPathRisks(p, config));
      if (risky.length > 0) {
        persist(addChangedFiles(run!, paths));
      }
    }

    return undefined;
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!isOpenRun(run)) return;
    if (run!.pendingGate && !run!.pendingGate.resolved) {
      ctx.ui.notify(
        `Skeg: pending gate (${run!.pendingGate.trigger}). Resolve or /finish --abandon.`,
        'warning',
      );
      return;
    }
    if (
      (run!.phase === 'change' || run!.phase === 'prove') &&
      run!.changedFiles.length > 0
    ) {
      const proved = runProveChecks(ctx.cwd, run!, config);
      persist(proved.run);
      const failed = proved.run.checks.filter((c) => !c.passed);
      if (failed.length > 0) {
        ctx.ui.notify(
          `Skeg prove: ${failed.map((c) => c.name).join(', ')} need attention.`,
          'warning',
        );
      } else if (proved.notes.length > 0) {
        ctx.ui.notify(`Skeg prove: ${proved.notes.join('; ')}`, 'info');
      }
    }
  });

  pi.on('session_before_compact', async () => {
    if (run) pi.appendEntry(RUN_ENTRY_TYPE, run);
  });

  pi.registerCommand('init', {
    description: 'Initialize .skeg/project.md and config.json',
    handler: async (args, ctx: ExtensionCommandContext) => {
      const force = /\b--force\b/.test(args || '');
      const result = initSkeg(ctx.cwd, force);
      reloadConfig(ctx.cwd);
      ctx.ui.notify(result.message, 'info');
    },
  });

  pi.registerCommand('run', {
    description: 'Start or resume a Skeg run',
    handler: async (args, ctx: ExtensionCommandContext) => {
      reloadConfig(ctx.cwd);
      const text = (args || '').trim();

      if (text === '--abandon' || text.startsWith('--abandon ')) {
        if (!isOpenRun(run)) {
          ctx.ui.notify('No open run to abandon.', 'info');
          return;
        }
        persist(closeRun(run!, 'abandoned'));
        ctx.ui.notify(`Abandoned run: ${run!.intent}`, 'info');
        return;
      }

      if (isOpenRun(run)) {
        ctx.ui.notify(
          `Open run exists:\n${formatStatus(run)}\n\nUse /finish, or /run --abandon, before starting another.`,
          'warning',
        );
        return;
      }

      if (!text) {
        ctx.ui.notify('Usage: /run <intent>', 'error');
        return;
      }

      acknowledged.clear();
      const next = createRun(text, config.defaultPolicy);
      persist(next);
      ctx.ui.notify(
        `Started run (${next.risk}): ${next.intent}\nPhases: Orient → Change → Prove → Close`,
        'info',
      );
    },
  });

  pi.registerCommand('status', {
    description: 'Show current Skeg run status',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!run) {
        run = latestRunFromEntries(ctx.sessionManager.getEntries());
      }
      ctx.ui.notify(formatStatus(run), 'info');
    },
  });

  pi.registerCommand('finish', {
    description: 'Close the current Skeg run after prove',
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!isOpenRun(run)) {
        ctx.ui.notify('No open run to finish.', 'info');
        return;
      }

      if (/\b--abandon\b/.test(args || '')) {
        persist(closeRun(run!, 'abandoned'));
        ctx.ui.notify(`Abandoned: ${run!.intent}`, 'info');
        return;
      }

      if (run!.pendingGate && !run!.pendingGate.resolved) {
        ctx.ui.notify(
          `Cannot finish: pending gate (${run!.pendingGate.trigger}). Resolve it or /finish --abandon.`,
          'warning',
        );
        return;
      }

      const proved = runProveChecks(ctx.cwd, run!, config);
      persist(proved.run);
      const closed = closeRun(setPhase(proved.run, 'close'), 'done');
      persist(closed);
      ctx.ui.notify(formatCloseReport(closed), 'info');
    },
  });

  pi.registerCommand('record', {
    description: 'Persist a long-lived record under .skeg/records/',
    handler: async (args, ctx: ExtensionCommandContext) => {
      const parsed = parseRecordArgs(args || '');
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, 'error');
        return;
      }

      if (!run) {
        run = latestRunFromEntries(ctx.sessionManager.getEntries());
      }

      const created = createRecord(ctx.cwd, {
        type: parsed.type,
        title: parsed.title,
        body: parsed.body,
        run,
      });

      if (run) {
        persist(addRecordId(run, created.id));
      }

      ctx.ui.notify(
        `Recorded ${created.id} (${created.type}): ${created.relativePath}`,
        'info',
      );
    },
  });
}
