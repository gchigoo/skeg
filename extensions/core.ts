/**
 * Skeg Pi 适配层：事件钩子 + 命令注册。
 * 机制逻辑在 src/，本文件只做宿主桥接。
 */
import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  captureBaseline,
  computeRunObservation,
  reconcileAgainstBaseline,
} from '../src/baseline.ts';
import { buildCommandCheck, classifyCheckCommand } from '../src/checks.ts';
import { handleCommand, notifyDiagnostics } from '../src/commands.ts';
import {
  loadConfig,
  loadConfigWithDiagnostics,
} from '../src/config.ts';
import { classifyBashEffect, isMutatingEffect } from '../src/effects.ts';
import {
  commandForCheckClassification,
  inspectExitIntegrity,
  unwrapShellWrapper,
} from '../src/exitintegrity.ts';
import {
  acknowledgedGates,
  clearHostSession,
  pendingMutations,
} from '../src/hostsession.ts';
import { maybeCompactRun } from '../src/compact.ts';
import { buildContextAuditPayload } from '../src/contextaudit.ts';
import { buildInjectContext } from '../src/inject.ts';
import { authorizeMutationPaths } from '../src/paths.ts';
import {
  classifyWithProviders,
  emptyProviders,
  loadProviders,
  mergePolicyHits,
  requiredPolicyUnavailable,
  type LoadedProviders,
  type ProviderRuntimeError,
} from '../src/providers.ts';
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
import { toolResultText } from '../src/tooloutput.ts';
import { buildRunContract } from '../src/contract.ts';
import { providersConfigHash } from '../src/trust.ts';
import { RUN_ENTRY_TYPE, type RunState, type SkegConfig } from '../src/types.ts';

/** 注入审计 entry（不进 LLM；供 smoke/host 观测 systemPrompt 注入）。 */
const CONTEXT_ENTRY_TYPE = 'skeg/context';

/**
 * Pi package 入口。
 * @param pi ExtensionAPI
 */
export default function (pi: ExtensionAPI) {
  let run: RunState | null = null;
  let config: SkegConfig = loadConfig(process.cwd());
  let providers: LoadedProviders = emptyProviders();
  /** 本 session 运行时失败后禁用的 provider spec */
  const disabledProviderSpecs = new Set<string>();
  /** 已对用户提示过的 provider 错误（每 spec 一次） */
  const providerErrorWarned = new Set<string>();
  /** 本 session 是否已提示过 providers 配置变更需 reload */
  let providersReloadHinted = false;
  /** 已落盘的注入内容 hash；变化时写 skeg/context 审计 entry */
  let lastInjectHash = '';
  let queue: Promise<void> = Promise.resolve();

  /**
   * 从 session entries 同步 RunState（reload / settle 后与落盘一致）。
   * 仅在内存为空、或 entries 更新时覆盖，避免覆盖尚未 flush 的 in-memory 更新。
   * @param ctx 含 sessionManager 的上下文
   */
  const syncRunFromEntries = (ctx: {
    sessionManager: { getEntries: () => Array<{ type?: string; customType?: string; data?: unknown }> };
  }) => {
    const fromEntries = latestRunFromEntries(ctx.sessionManager.getEntries());
    if (!fromEntries) return;
    if (
      !run ||
      fromEntries.id !== run.id ||
      fromEntries.updatedAt > run.updatedAt
    ) {
      run = fromEntries;
    }
  };

  const reloadProviders = async (cwd: string, next: SkegConfig) => {
    providers = await loadProviders(cwd, next);
    disabledProviderSpecs.clear();
    providerErrorWarned.clear();
    providersReloadHinted = false;
    return providers;
  };

  const noteProviderErrors = (
    ui: { notify: (m: string, l: 'info' | 'warning' | 'error') => void },
    errors: ProviderRuntimeError[],
  ) => {
    for (const err of errors) {
      disabledProviderSpecs.add(err.spec);
      if (providerErrorWarned.has(err.spec)) continue;
      providerErrorWarned.add(err.spec);
      ui.notify(
        `Skeg provider ${err.spec} (${err.kind}) failed and was disabled for this session: ${err.message}`,
        'warning',
      );
    }
  };

  const dispatch = (event: SkegEvent): Promise<void> => {
    // catch 防毒化：单次 reduce 异常后队列仍可继续
    queue = queue
      .then(() => {
        const next = maybeCompactRun(reduce(run, event));
        if (!sameState(run, next)) {
          run = next;
          pi.appendEntry(RUN_ENTRY_TYPE, next);
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          // ExtensionAPI 无全局 ui；异常吞掉以免毒化后续 dispatch
          console.warn(`Skeg dispatch error (queue kept alive): ${message}`);
        } catch {
          /* ignore */
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
      clearHostSession();
    },
    getEntries: () => [] as Array<{ type?: string; customType?: string; data?: unknown }>,
    getProviders: () => providers,
    reloadProviders: async () => {
      // cwd 由调用方在 handleCommand 前已写入 config；这里用 process.cwd 会被覆盖
      return providers;
    },
  };

  pi.on('session_start', async (_event, ctx) => {
    lastInjectHash = '';
    const loaded = loadConfigWithDiagnostics(ctx.cwd);
    config = loaded.config;
    const next = await reloadProviders(ctx.cwd, config);
    notifyDiagnostics(ctx.ui, [...loaded.diagnostics, ...next.diagnostics]);
    run = latestRunFromEntries(ctx.sessionManager.getEntries());
    commandDeps.getEntries = () => ctx.sessionManager.getEntries();
    commandDeps.reloadProviders = async () => {
      const cfg = loadConfigWithDiagnostics(ctx.cwd);
      config = cfg.config;
      return reloadProviders(ctx.cwd, config);
    };
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const loaded = loadConfigWithDiagnostics(ctx.cwd);
    config = loaded.config;
    // session 级冻结：配置变化只提示 reload，不自动 import
    const nextHash = providersConfigHash(config.providers);
    if (nextHash !== providers.configHash && !providersReloadHinted) {
      providersReloadHinted = true;
      ctx.ui.notify(
        'Skeg: providers config changed; run /skeg providers reload to apply.',
        'warning',
      );
    }
    notifyDiagnostics(ctx.ui, loaded.diagnostics);
    syncRunFromEntries(ctx);
    commandDeps.getEntries = () => ctx.sessionManager.getEntries();
    commandDeps.reloadProviders = async () => {
      const cfg = loadConfigWithDiagnostics(ctx.cwd);
      config = cfg.config;
      return reloadProviders(ctx.cwd, config);
    };

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
          contract: buildRunContract(config),
        });
        clearHostSession();
      }
    }

    const content = buildInjectContext(run, config, ctx.cwd, {
      recordSelectors: providers.records,
      disabledProviderSpecs,
      onProviderErrors: (errors) => noteProviderErrors(ctx.ui, errors),
    });
    // RPC 不暴露 systemPrompt；hash 变化时落审计（默认摘要；full 才带 content）
    const injectHash = createHash('sha256').update(content).digest('hex');
    if (injectHash !== lastInjectHash) {
      lastInjectHash = injectHash;
      pi.appendEntry(
        CONTEXT_ENTRY_TYPE,
        buildContextAuditPayload(content, injectHash),
      );
    }
    const base = event.systemPrompt ?? '';
    return { systemPrompt: base ? `${base}\n\n${content}` : content };
  });

  pi.on('tool_call', async (event, ctx) => {
    syncRunFromEntries(ctx);
    if (!isOpenRun(run)) return undefined;
    if (run!.pendingGate?.resolved) await dispatch({ type: 'GATE_CLEARED' });

    const input = event.input as Record<string, unknown>;
    const tool = event.toolName.toLowerCase();
    const toolCallId =
      (event as { toolCallId?: string }).toolCallId ??
      `anon_${Date.now().toString(36)}`;

    if (tool === 'write' || tool === 'edit') {
      const auth = authorizeMutationPaths(
        ctx.cwd,
        pathsFromToolCall(event.toolName, input),
      );
      if (auth.blocked.length > 0) {
        return {
          block: true,
          reason: `Skeg blocked write outside workspace or .git: ${auth.blocked[0].path}`,
        };
      }
      pendingMutations.set({
        toolCallId,
        expectedPaths: auth.allowed,
        effect: { kind: tool as 'write' | 'edit' },
      });
    }

    if (tool === 'bash' && typeof input.command === 'string') {
      const effect = classifyBashEffect(input.command);
      if (effect.kind === 'read') return undefined;
      if (
        effect.kind === 'file-mutation' ||
        effect.kind === 'dependency-mutation'
      ) {
        const auth = authorizeMutationPaths(ctx.cwd, effect.paths);
        if (auth.blocked.length > 0) {
          return {
            block: true,
            reason: `Skeg blocked write outside workspace or .git: ${auth.blocked[0].path}`,
          };
        }
        pendingMutations.set({
          toolCallId,
          expectedPaths: auth.allowed,
          effect,
        });
      } else if (isMutatingEffect(effect) || effect.kind === 'unknown') {
        pendingMutations.set({
          toolCallId,
          expectedPaths: [],
          effect,
        });
      }
    }

    const paths = pathsFromToolCall(event.toolName, input);
    const merged = mergePolicyHits(
      scanToolCall(event.toolName, input, config),
      { toolName: event.toolName, input, paths },
      config,
      providers.policies,
      disabledProviderSpecs,
    );
    noteProviderErrors(ctx.ui, merged.errors);
    if (merged.diagnostics.length > 0) notifyDiagnostics(ctx.ui, merged.diagnostics);
    const mutating =
      tool === 'write' ||
      tool === 'edit' ||
      (tool === 'bash' &&
        typeof input.command === 'string' &&
        classifyBashEffect(input.command).kind !== 'read');
    const requiredFail = mutating
      ? requiredPolicyUnavailable(
          providers,
          disabledProviderSpecs,
          merged.errors,
        )
      : null;
    if (requiredFail) {
      pendingMutations.take(toolCallId);
      return {
        block: true,
        reason: `Skeg blocked (provider-error): ${requiredFail}`,
      };
    }
    const gatedHits = merged.hits.filter((h) => requiresGate(h.trigger, config));
    if (gatedHits.length === 0) return undefined;

    const blocked = gatedHits.find((h) => requiresBlock(h.trigger, config));
    if (blocked) {
      pendingMutations.take(toolCallId);
      return {
        block: true,
        reason: `Skeg blocked (${blocked.trigger}): ${blocked.reason}`,
      };
    }

    const fp = actionFingerprint(gatedHits, event.toolName, input);
    if (
      gatedHits.every((h) => acknowledgedGates.has(gateAcknowledgementKey(h))) ||
      acknowledgedGates.has(fp)
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
      pendingMutations.take(toolCallId);
      return {
        block: true,
        reason: `Skeg blocked (${gatedHits[0].trigger}): ${gatedHits[0].reason}`,
      };
    }

    const ok = await ctx.ui.confirm(title, body);
    if (!ok) {
      pendingMutations.take(toolCallId);
      await dispatch({ type: 'GATE_RESOLVED', approved: false });
      return {
        block: true,
        reason: `Skeg gate denied: ${gatedHits.map((h) => h.trigger).join(', ')}`,
      };
    }

    for (const h of gatedHits) acknowledgedGates.add(gateAcknowledgementKey(h));
    acknowledgedGates.add(fp);
    await dispatch({ type: 'GATE_RESOLVED', approved: true });
    return undefined;
  });

  pi.on('tool_result', async (event, ctx) => {
    syncRunFromEntries(ctx);
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
      // wrapper 用 payload 分类；外层无法 unwrap 时，引号内命中不算证据
      const classifyText = commandForCheckClassification(command);
      const outerClassified = classifyCheckCommand(command, config);
      const innerClassified = classifyCheckCommand(classifyText, config);
      const wrapper = unwrapShellWrapper(command);
      // 仅外层（引号内）命中且无法识别 wrapper → 不计入证据
      if (outerClassified && !innerClassified && !wrapper) {
        ctx.ui.notify(
          `Skeg did not count this as ${outerClassified.name} evidence: check matched inside quotes of an unparsed wrapper. Run the check as a standalone command.`,
          'warning',
        );
      } else {
        const classified = classifyWithProviders(
          classifyText,
          config,
          innerClassified,
          providers.checks,
          disabledProviderSpecs,
        );
        noteProviderErrors(ctx.ui, classified.errors);
        if (classified.diagnostics.length > 0) {
          notifyDiagnostics(ctx.ui, classified.diagnostics);
        }
        if (classified.check) {
          if (inspectExitIntegrity(command) === 'masked') {
            ctx.ui.notify(
              `Skeg did not count this as ${classified.check.name} evidence: the exit status may be masked by shell operators. Run the check as a standalone command.`,
              'warning',
            );
          } else {
            await dispatch({
              type: 'CHECK_RECORDED',
              check: buildCommandCheck(
                classified.check.name,
                command,
                !event.isError,
                toolResultText(event.content),
                classified.check.source,
              ),
            });
          }
        }
      }
    }
    return undefined;
  });

  const settle = async (ctx: {
    cwd: string;
    ui: { notify: (m: string, l: 'info' | 'warning' | 'error') => void };
    sessionManager: {
      getEntries: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    };
  }) => {
    syncRunFromEntries(ctx);
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

    // 滚动指纹：同路径内容变化等未记账 mutation 必须 bump revision
    if (run!.changedFiles.length > 0 || run!.observation) {
      const observed = computeRunObservation(ctx.cwd, run!);
      await dispatch({
        type: 'WORKSPACE_OBSERVED',
        hash: observed.hash,
        head: observed.head,
      });
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
  // agent_settled：peer 下限小版本类型面可能尚未列入；运行时仍注册
  (
    pi.on as (
      event: string,
      handler: (
        event: unknown,
        ctx: Parameters<typeof settle>[0],
      ) => void | Promise<void>,
    ) => void
  )('agent_settled', async (_event, ctx) => {
    await settle(ctx);
  });
  pi.on('session_before_compact', async () => {
    if (run) pi.appendEntry(RUN_ENTRY_TYPE, run);
  });

  pi.registerCommand('skeg', {
    description:
      'Skeg: init|start|status|finish|record|providers|trust|untrust|doctor',
    handler: async (args, ctx) => {
      commandDeps.getEntries = () => ctx.sessionManager.getEntries();
      commandDeps.reloadProviders = async () => {
        const cfg = loadConfigWithDiagnostics(ctx.cwd);
        config = cfg.config;
        return reloadProviders(ctx.cwd, config);
      };
      const text = (args || '').trim();
      const match = text.match(/^(\S+)\s*([\s\S]*)$/);
      await handleCommand(match?.[1] ?? '', match?.[2] ?? '', ctx, commandDeps);
    },
  });
}
