/**
 * Skeg Pi 适配层：事件钩子 + 命令注册。
 * 机制逻辑在 src/，本文件只做宿主桥接。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { captureBaseline, reconcileAgainstBaseline } from '../src/baseline.ts';
import { buildCommandCheck, classifyCheckCommand } from '../src/checks.ts';
import { handleCommand, notifyDiagnostics } from '../src/commands.ts';
import {
  loadConfig,
  loadConfigWithDiagnostics,
} from '../src/config.ts';
import { classifyBashEffect, isMutatingEffect } from '../src/effects.ts';
import { buildInjectContext } from '../src/inject.ts';
import { PendingMutationTable } from '../src/pending.ts';
import { toWorkspacePath } from '../src/paths.ts';
import { healChangedFilesFromGit, runProveChecks } from '../src/prove.ts';
import { reduce, sameState, type SkegEvent } from '../src/reducer.ts';
import {
  actionFingerprint,
  gateAcknowledgementKey,
  pathsFromToolCall,
  requiresBlock,
  requiresGate,
  scanToolCall,
} from '../src/risk.ts';
import { isOpenRun, latestRunFromEntries } from '../src/run.ts';
import { RUN_ENTRY_TYPE, type RunState, type SkegConfig } from '../src/types.ts';

/**
 * Pi package 入口。
 * @param pi ExtensionAPI
 */
export default function (pi: ExtensionAPI) {
  let run: RunState | null = null;
  let config: SkegConfig = loadConfig(process.cwd());
  const acknowledged = new Set<string>();
  const pendingMutations = new PendingMutationTable();
  let queue: Promise<void> = Promise.resolve();

  const dispatch = (event: SkegEvent): Promise<void> => {
    queue = queue.then(() => {
      const next = reduce(run, event);
      if (!sameState(run, next)) {
        run = next;
        pi.appendEntry(RUN_ENTRY_TYPE, next);
      }
    });
    return queue;
  };

  const commandDeps = {
    getRun: () => run,
    setRun: (next: RunState | null) => {
      run = next;
    },
    getConfig: () => config,
    setConfig: (next: SkegConfig) => {
      config = next;
    },
    dispatch,
    appendEntry: (type: string, data: RunState) => pi.appendEntry(type, data),
    clearSession: () => {
      acknowledged.clear();
      pendingMutations.clear();
    },
    getEntries: () => [] as Array<{ type?: string; customType?: string; data?: unknown }>,
  };

  pi.on('session_start', async (_event, ctx) => {
    const loaded = loadConfigWithDiagnostics(ctx.cwd);
    config = loaded.config;
    notifyDiagnostics(ctx.ui, loaded.diagnostics);
    run = latestRunFromEntries(ctx.sessionManager.getEntries());
    commandDeps.getEntries = () => ctx.sessionManager.getEntries();
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const loaded = loadConfigWithDiagnostics(ctx.cwd);
    config = loaded.config;
    notifyDiagnostics(ctx.ui, loaded.diagnostics);
    if (!run) run = latestRunFromEntries(ctx.sessionManager.getEntries());
    commandDeps.getEntries = () => ctx.sessionManager.getEntries();

    const prompt = event.prompt ?? '';
    if (!isOpenRun(run) && prompt.includes('<!-- skeg:run -->')) {
      const intent = prompt
        .replace(/<!--\s*skeg:run\s*-->/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      if (intent) {
        await dispatch({
          type: 'RUN_STARTED',
          intent,
          risk: config.defaultPolicy,
          baseline: captureBaseline(ctx.cwd),
        });
        acknowledged.clear();
        pendingMutations.clear();
      }
    }

    const content = buildInjectContext(run, config, ctx.cwd);
    const base = event.systemPrompt ?? '';
    return { systemPrompt: base ? `${base}\n\n${content}` : content };
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!isOpenRun(run)) return undefined;
    if (run!.pendingGate?.resolved) await dispatch({ type: 'GATE_CLEARED' });

    const input = event.input as Record<string, unknown>;
    const tool = event.toolName.toLowerCase();
    const toolCallId =
      (event as { toolCallId?: string }).toolCallId ??
      `anon_${Date.now().toString(36)}`;

    if (tool === 'write' || tool === 'edit') {
      const expectedPaths: string[] = [];
      for (const p of pathsFromToolCall(event.toolName, input)) {
        const wp = toWorkspacePath(ctx.cwd, p);
        if (wp.outsideWorkspace || wp.relativePath.startsWith('.git/')) {
          return {
            block: true,
            reason: `Skeg blocked write outside workspace or .git: ${p}`,
          };
        }
        expectedPaths.push(wp.relativePath);
      }
      pendingMutations.set({
        toolCallId,
        expectedPaths,
        effect: { kind: tool as 'write' | 'edit' },
      });
    }

    if (tool === 'bash' && typeof input.command === 'string') {
      const effect = classifyBashEffect(input.command);
      if (effect.kind === 'read') return undefined;
      const expectedPaths =
        effect.kind === 'file-mutation' || effect.kind === 'dependency-mutation'
          ? effect.paths.map((p) => toWorkspacePath(ctx.cwd, p).relativePath)
          : [];
      if (isMutatingEffect(effect) || effect.kind === 'unknown') {
        pendingMutations.set({ toolCallId, expectedPaths, effect });
      }
    }

    const gatedHits = scanToolCall(event.toolName, input, config).filter((h) =>
      requiresGate(h.trigger, config),
    );
    if (gatedHits.length === 0) return undefined;

    const blocked = gatedHits.find((h) => requiresBlock(h.trigger, config));
    if (blocked) {
      return {
        block: true,
        reason: `Skeg blocked (${blocked.trigger}): ${blocked.reason}`,
      };
    }

    const fp = actionFingerprint(gatedHits, event.toolName, input);
    if (
      gatedHits.every((h) => acknowledged.has(gateAcknowledgementKey(h))) ||
      acknowledged.has(fp)
    ) {
      return undefined;
    }

    await dispatch({
      type: 'GATE_OPENED',
      gate: {
        hits: gatedHits,
        actionFingerprint: fp,
        scope: 'call',
        trigger: gatedHits[0].trigger,
        reason: gatedHits.map((h) => `- ${h.trigger}: ${h.reason}`).join('\n'),
        path: gatedHits[0].path || undefined,
      },
    });

    const title = `Skeg gate: ${gatedHits.map((h) => h.trigger).join(', ')}`;
    const body = [
      'Skeg blocked this action.',
      '',
      'Detected:',
      ...gatedHits.map((h) => `- ${h.trigger}: ${h.reason}`),
      '',
      'Allow this exact action?',
    ].join('\n');

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Skeg blocked (${gatedHits[0].trigger}): ${gatedHits[0].reason}`,
      };
    }

    const ok = await ctx.ui.confirm(title, body);
    if (!ok) {
      await dispatch({ type: 'GATE_RESOLVED', approved: false });
      return {
        block: true,
        reason: `Skeg gate denied: ${gatedHits.map((h) => h.trigger).join(', ')}`,
      };
    }

    for (const h of gatedHits) acknowledged.add(gateAcknowledgementKey(h));
    acknowledged.add(fp);
    await dispatch({ type: 'GATE_RESOLVED', approved: true });
    return undefined;
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!isOpenRun(run)) return undefined;
    config = loadConfig(ctx.cwd);

    const toolCallId = (event as { toolCallId?: string }).toolCallId ?? '';
    const pending = toolCallId ? pendingMutations.take(toolCallId) : undefined;

    if (!event.isError && pending && pending.expectedPaths.length > 0) {
      const kind = pending.effect.kind;
      if (
        kind === 'write' ||
        kind === 'edit' ||
        kind === 'file-mutation' ||
        kind === 'dependency-mutation'
      ) {
        await dispatch({
          type: 'MUTATION_COMMITTED',
          paths: pending.expectedPaths,
        });
      }
    }

    if (event.toolName.toLowerCase() === 'bash') {
      const input = event.input as Record<string, unknown>;
      const command = typeof input.command === 'string' ? input.command : '';
      const classified = classifyCheckCommand(command, config);
      if (classified) {
        const output =
          typeof event.content === 'string'
            ? event.content
            : Array.isArray(event.content)
              ? event.content
                  .map((c) =>
                    typeof c === 'string'
                      ? c
                      : typeof c === 'object' && c && 'text' in c
                        ? String((c as { text?: unknown }).text ?? '')
                        : '',
                  )
                  .join('\n')
              : '';
        await dispatch({
          type: 'CHECK_RECORDED',
          check: buildCommandCheck(
            classified.name,
            command,
            !event.isError,
            output,
          ),
        });
      }
    }
    return undefined;
  });

  const settle = async (ctx: {
    cwd: string;
    ui: { notify: (m: string, l: 'info' | 'warning' | 'error') => void };
  }) => {
    if (!isOpenRun(run)) return;
    if (run!.pendingGate && !run!.pendingGate.resolved) {
      ctx.ui.notify(
        `Skeg: pending gate (${run!.pendingGate.trigger}). Resolve or /finish --abandon.`,
        'warning',
      );
      return;
    }

    if (run!.baseline?.capturedAt) {
      const reconciled = reconcileAgainstBaseline(ctx.cwd, run!.baseline);
      const trulyNew = reconciled.runChanges.filter(
        (f) => !run!.changedFiles.includes(f),
      );
      if (trulyNew.length > 0 || reconciled.headMoved) {
        await dispatch({
          type: 'WORKSPACE_RECONCILED',
          changedFiles: trulyNew,
          preExistingFiles: reconciled.preExisting,
          headMoved: reconciled.headMoved,
        });
      } else if (reconciled.preExisting.length > 0 && !run!.preExistingFiles) {
        await dispatch({
          type: 'WORKSPACE_RECONCILED',
          changedFiles: [],
          preExistingFiles: reconciled.preExisting,
        });
      }
    } else {
      const healed = healChangedFilesFromGit(ctx.cwd, run!);
      if (!sameState(run, healed)) {
        run = healed;
        pi.appendEntry(RUN_ENTRY_TYPE, healed);
      }
    }

    if (
      (run!.phase === 'change' || run!.phase === 'prove') &&
      run!.changedFiles.length > 0
    ) {
      const proved = runProveChecks(ctx.cwd, run!, config);
      if (!sameState(run, proved.run)) {
        run = proved.run;
        pi.appendEntry(RUN_ENTRY_TYPE, proved.run);
      }
      const failed = proved.run.checks.filter(
        (c) => !c.passed && c.revision === proved.run.revision,
      );
      if (failed.length > 0) {
        ctx.ui.notify(
          `Skeg prove: ${failed.map((c) => c.name).join(', ')} need attention.`,
          'warning',
        );
      } else if (proved.notes.length > 0) {
        ctx.ui.notify(`Skeg prove: ${proved.notes.join('; ')}`, 'info');
      }
    }
  };

  pi.on('agent_end', async () => {
    /* telemetry only */
  });
  pi.on('agent_settled', async (_event, ctx) => {
    await settle(ctx);
  });
  pi.on('session_before_compact', async () => {
    if (run) pi.appendEntry(RUN_ENTRY_TYPE, run);
  });

  for (const name of ['init', 'run', 'status', 'finish', 'record'] as const) {
    pi.registerCommand(name, {
      description: `Skeg ${name}`,
      handler: async (args, ctx) => {
        commandDeps.getEntries = () => ctx.sessionManager.getEntries();
        await handleCommand(name, args || '', ctx, commandDeps);
      },
    });
  }

  pi.registerCommand('skeg', {
    description: 'Skeg: init|start|status|finish|record',
    handler: async (args, ctx) => {
      commandDeps.getEntries = () => ctx.sessionManager.getEntries();
      const text = (args || '').trim();
      const match = text.match(/^(\S+)\s*([\s\S]*)$/);
      await handleCommand(match?.[1] ?? '', match?.[2] ?? '', ctx, commandDeps);
    },
  });
}
