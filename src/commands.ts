/**
 * Skeg slash 命令处理（宿主无关编排，经 dispatch 回调写状态）。
 */
import { captureBaseline } from './baseline.ts';
import {
  evaluateClosure,
  formatClosureFailure,
} from './closure.ts';
import { loadConfigWithDiagnostics } from './config.ts';
import {
  buildRunContract,
  formatContractDriftHint,
  hasContractDrift,
} from './contract.ts';
import { buildDoctorReport } from './doctor.ts';
import { initSkeg } from './init.ts';
import {
  formatProvidersStatus,
  type LoadedProviders,
} from './providers.ts';
import { createRecord, parseRecordArgs } from './record.ts';
import { runProveChecks } from './prove.ts';
import { sameState, type SkegEvent } from './reducer.ts';
import {
  formatCloseReport,
  formatStatus,
  hasCliFlag,
  isOpenRun,
  latestRunFromEntries,
  parseWaiveReason,
} from './run.ts';
import { trustProvider, untrustProvider } from './trust.ts';
import { RUN_ENTRY_TYPE, type RunState, type SkegConfig } from './types.ts';

export type CommandUi = {
  notify: (message: string, level: 'info' | 'warning' | 'error') => void;
};

export type CommandContext = {
  cwd: string;
  ui: CommandUi;
};

export type CommandDeps = {
  getRun: () => RunState | null;
  setRun: (run: RunState | null) => void;
  getConfig: () => SkegConfig;
  setConfig: (config: SkegConfig) => void;
  dispatch: (event: SkegEvent) => Promise<void>;
  appendEntry: (type: string, data: RunState) => void;
  clearSession: () => void;
  getEntries: () => Array<{
    type?: string;
    customType?: string;
    data?: unknown;
  }>;
  getProviders: () => LoadedProviders;
  reloadProviders: () => Promise<LoadedProviders>;
};

/**
 * 通知配置诊断。
 * @param ui UI
 * @param diagnostics 诊断列表
 */
export function notifyDiagnostics(
  ui: CommandUi,
  diagnostics: ReturnType<typeof loadConfigWithDiagnostics>['diagnostics'],
): void {
  for (const d of diagnostics) {
    if (d.level === 'error' || d.level === 'warning') {
      ui.notify(
        `Skeg config ${d.level}${d.path ? ` (${d.path})` : ''}: ${d.message}`,
        d.level === 'error' ? 'error' : 'warning',
      );
    }
  }
}

/**
 * 处理 skeg 子命令。
 * @param name 子命令
 * @param args 参数
 * @param ctx 命令上下文
 * @param deps 依赖
 */
export async function handleCommand(
  name: string,
  args: string,
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<void> {
  const reload = () => {
    const result = loadConfigWithDiagnostics(ctx.cwd);
    deps.setConfig(result.config);
    return result;
  };

  switch (name) {
    case 'init': {
      const result = initSkeg(ctx.cwd, hasCliFlag(args, '--force'));
      reload();
      ctx.ui.notify(result.message, 'info');
      return;
    }
    case 'run':
    case 'start': {
      const loaded = reload();
      notifyDiagnostics(ctx.ui, loaded.diagnostics);
      const text = (args || '').trim();
      const run = deps.getRun();
      if (text === '--abandon' || text.startsWith('--abandon ')) {
        if (!isOpenRun(run)) {
          ctx.ui.notify('No open run to abandon.', 'info');
          return;
        }
        await deps.dispatch({ type: 'RUN_FINISHED', status: 'abandoned' });
        ctx.ui.notify(`Abandoned run: ${deps.getRun()!.intent}`, 'info');
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
        ctx.ui.notify('Usage: /run <intent> (or /skeg start <intent>)', 'error');
        return;
      }
      deps.clearSession();
      const baseline = captureBaseline(ctx.cwd);
      const cfg = deps.getConfig();
      await deps.dispatch({
        type: 'RUN_STARTED',
        intent: text,
        risk: cfg.defaultPolicy,
        baseline,
        contract: buildRunContract(cfg),
      });
      const started = deps.getRun();
      const pre =
        baseline.dirtyFiles.length > 0
          ? `\nPre-existing workspace changes: ${baseline.dirtyFiles.join(', ')}`
          : '';
      ctx.ui.notify(
        `Started run (${started!.risk}): ${started!.intent}\nPhases: Orient → Change → Prove → Close${pre}`,
        'info',
      );
      return;
    }
    case 'status': {
      if (!deps.getRun()) {
        deps.setRun(latestRunFromEntries(deps.getEntries()));
      }
      const loaded = reload();
      notifyDiagnostics(ctx.ui, loaded.diagnostics);
      const run = deps.getRun();
      let text = formatStatus(run);
      if (hasContractDrift(run, deps.getConfig())) {
        text = `${text}\n${formatContractDriftHint()}`;
      }
      ctx.ui.notify(text, 'info');
      return;
    }
    case 'finish': {
      if (!isOpenRun(deps.getRun())) {
        ctx.ui.notify('No open run to finish.', 'info');
        return;
      }
      if (hasCliFlag(args, '--abandon')) {
        await deps.dispatch({ type: 'RUN_FINISHED', status: 'abandoned' });
        ctx.ui.notify(`Abandoned: ${deps.getRun()!.intent}`, 'info');
        return;
      }

      const proved = runProveChecks(ctx.cwd, deps.getRun()!, deps.getConfig());
      if (!sameState(deps.getRun(), proved.run)) {
        deps.setRun(proved.run);
        deps.appendEntry(RUN_ENTRY_TYPE, proved.run);
      }

      let evaluation = evaluateClosure(deps.getRun()!, deps.getConfig());
      const waiveReason = parseWaiveReason(args);
      if (!evaluation.ok && waiveReason) {
        await deps.dispatch({
          type: 'WAIVER_ADDED',
          waiver: {
            reason: waiveReason,
            missingChecks: [
              ...evaluation.missing,
              ...evaluation.failed,
              ...evaluation.stale,
            ],
            revision: deps.getRun()!.revision,
          },
        });
        evaluation = evaluateClosure(deps.getRun()!, deps.getConfig());
      }

      if (!evaluation.ok) {
        ctx.ui.notify(
          formatClosureFailure(evaluation, deps.getRun()!),
          'warning',
        );
        return;
      }

      await deps.dispatch({ type: 'PHASE_SET', phase: 'close' });
      await deps.dispatch({ type: 'RUN_FINISHED', status: 'done' });
      ctx.ui.notify(formatCloseReport(deps.getRun()!), 'info');
      return;
    }
    case 'record': {
      const parsed = parseRecordArgs(args || '');
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, 'error');
        return;
      }
      if (!deps.getRun()) {
        deps.setRun(latestRunFromEntries(deps.getEntries()));
      }
      const run = deps.getRun();
      const created = createRecord(ctx.cwd, {
        type: parsed.type,
        title: parsed.title,
        body: parsed.body,
        run,
      });
      if (run) {
        await deps.dispatch({ type: 'RECORD_ADDED', recordId: created.id });
      }
      ctx.ui.notify(
        `Recorded ${created.id} (${created.type}): ${created.relativePath}`,
        'info',
      );
      return;
    }
    case 'providers': {
      const sub = (args || '').trim();
      if (sub === 'reload') {
        const loaded = reload();
        notifyDiagnostics(ctx.ui, loaded.diagnostics);
        const providers = await deps.reloadProviders();
        notifyDiagnostics(ctx.ui, providers.diagnostics);
        ctx.ui.notify(
          `Reloaded providers (${providers.policies.length} policy, ${providers.checks.length} check, ${providers.records.length} record).`,
          'info',
        );
        return;
      }
      if (sub) {
        ctx.ui.notify(
          'Usage: /skeg providers | /skeg providers reload',
          'error',
        );
        return;
      }
      const loaded = reload();
      notifyDiagnostics(ctx.ui, loaded.diagnostics);
      ctx.ui.notify(
        formatProvidersStatus(ctx.cwd, deps.getConfig(), deps.getProviders()),
        'info',
      );
      return;
    }
    case 'trust': {
      const spec = (args || '').trim();
      if (!spec) {
        ctx.ui.notify('Usage: /skeg trust <provider-spec>', 'error');
        return;
      }
      const result = trustProvider(ctx.cwd, spec);
      ctx.ui.notify(result.message, result.ok ? 'info' : 'error');
      if (result.ok) {
        const providers = await deps.reloadProviders();
        notifyDiagnostics(ctx.ui, providers.diagnostics);
      }
      return;
    }
    case 'untrust': {
      const spec = (args || '').trim();
      if (!spec) {
        ctx.ui.notify('Usage: /skeg untrust <provider-spec>', 'error');
        return;
      }
      const result = untrustProvider(ctx.cwd, spec);
      ctx.ui.notify(result.message, result.ok ? 'info' : 'error');
      if (result.ok) {
        const providers = await deps.reloadProviders();
        notifyDiagnostics(ctx.ui, providers.diagnostics);
      }
      return;
    }
    case 'doctor': {
      const loaded = reload();
      notifyDiagnostics(ctx.ui, loaded.diagnostics);
      if (!deps.getRun()) {
        deps.setRun(latestRunFromEntries(deps.getEntries()));
      }
      ctx.ui.notify(
        buildDoctorReport({
          cwd: ctx.cwd,
          run: deps.getRun(),
          config: deps.getConfig(),
          providers: deps.getProviders(),
        }),
        'info',
      );
      return;
    }
    default:
      ctx.ui.notify(
        `Unknown skeg command: ${name}. Try init|start|status|finish|record|providers|trust|untrust|doctor`,
        'error',
      );
  }
}
