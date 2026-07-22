/**
 * Skeg 兼容层：扁平 /init /run /status /finish /record。
 * v0.8 起从 core 拆出；v1.0 将从默认 pi.extensions 移除。
 * RunState 经 session entries 与 core 共享；gate/pending 经 src/hostsession.ts 共享。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { handleCommand } from '../src/commands.ts';
import {
  loadConfig,
  loadConfigWithDiagnostics,
} from '../src/config.ts';
import { clearHostSession } from '../src/hostsession.ts';
import {
  emptyProviders,
  loadProviders,
  type LoadedProviders,
} from '../src/providers.ts';
import { reduce, sameState, type SkegEvent } from '../src/reducer.ts';
import { latestRunFromEntries } from '../src/run.ts';
import { RUN_ENTRY_TYPE, type RunState, type SkegConfig } from '../src/types.ts';

/**
 * Pi package 兼容入口（扁平弃用命令）。
 * @param pi ExtensionAPI
 */
export default function (pi: ExtensionAPI) {
  let run: RunState | null = null;
  let config: SkegConfig = loadConfig(process.cwd());
  let providers: LoadedProviders = emptyProviders();
  /** 本 session 已提示过的扁平弃用命令 */
  const deprecatedWarned = new Set<string>();
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
      clearHostSession();
      deprecatedWarned.clear();
    },
    getEntries: () =>
      [] as Array<{ type?: string; customType?: string; data?: unknown }>,
    getProviders: () => providers,
    reloadProviders: async () => providers,
  };

  pi.on('session_start', async (_event, ctx) => {
    const loaded = loadConfigWithDiagnostics(ctx.cwd);
    config = loaded.config;
    providers = await loadProviders(ctx.cwd, config);
    run = latestRunFromEntries(ctx.sessionManager.getEntries());
  });

  for (const name of ['init', 'run', 'status', 'finish', 'record'] as const) {
    pi.registerCommand(name, {
      description: `Skeg ${name} (deprecated: use /skeg ${name === 'run' ? 'start' : name})`,
      handler: async (args, ctx) => {
        if (!deprecatedWarned.has(name)) {
          deprecatedWarned.add(name);
          const alias = name === 'run' ? 'start' : name;
          ctx.ui.notify(
            `Skeg: /${name} is deprecated; use /skeg ${alias}`,
            'info',
          );
        }
        // 与 core 同步：从 entries 恢复 run，并刷新 config/providers
        run = latestRunFromEntries(ctx.sessionManager.getEntries());
        const cfg = loadConfigWithDiagnostics(ctx.cwd);
        config = cfg.config;
        commandDeps.getEntries = () => ctx.sessionManager.getEntries();
        commandDeps.reloadProviders = async () => {
          providers = await loadProviders(ctx.cwd, config);
          return providers;
        };
        await handleCommand(name, args || '', ctx, commandDeps);
      },
    });
  }
}
