/**
 * /skeg status --why：可验证解释（block / gate / required / stale / drift）。
 */
import { evaluateClosure, currentWaiver } from './closure.ts';
import {
  configContractHash,
  requiredChecksFromContract,
} from './contract.ts';
import { currentChecks } from './run.ts';
import { providersConfigHash } from './trust.ts';
import type { RunState, SkegConfig } from './types.ts';

/**
 * 构建 why 报告文本。
 * @param run 当前 run
 * @param config 当前配置
 * @returns 多行文本
 */
export function buildWhyReport(
  run: RunState | null,
  config: SkegConfig,
): string {
  if (!run) {
    return 'No active Skeg run. Use /skeg start <intent> to start.';
  }

  const lines: string[] = ['# Why', ''];
  lines.push(...sectionRisk(run));
  lines.push('');
  lines.push(...sectionGates(run));
  lines.push('');
  lines.push(...sectionRequired(run, config));
  lines.push('');
  lines.push(...sectionWaivers(run));
  lines.push('');
  lines.push(...sectionDrift(run, config));
  return lines.join('\n').trim();
}

/**
 * Risk 节：为何 lean/guarded。
 * @param run run
 * @returns 行
 */
function sectionRisk(run: RunState): string[] {
  const lines = [
    '## Risk',
    `Risk is ${run.risk} (${run.riskSource}) at revision ${run.revision}.`,
  ];
  if (run.risk === 'lean') {
    lines.push('No deterministic upgrade; defaultPolicy / advisory only.');
    return lines;
  }
  const pending = run.pendingGate && !run.pendingGate.resolved
    ? run.pendingGate
    : undefined;
  if (pending) {
    const src = hitSources(pending.hits);
    lines.push(
      `Triggered by gate ${pending.trigger}: ${firstLine(pending.reason)}${src}`,
    );
  }
  const det = run.signals
    .filter(
      (s) =>
        s.revision === run.revision &&
        (s.strength === 'deterministic' || s.strength === 'semi'),
    )
    .slice(0, 5);
  for (const s of det) {
    lines.push(
      `Signal ${s.trigger}@r${s.revision} (${s.strength}): ${firstLine(s.evidence)}`,
    );
  }
  if (!pending && det.length === 0 && run.riskSource === 'advisory') {
    lines.push('Upgraded by advisory RISK_ADVISORY (no deterministic hit).');
  }
  return lines;
}

/**
 * Gates 节。
 * @param run run
 * @returns 行
 */
function sectionGates(run: RunState): string[] {
  const lines = ['## Gates'];
  if (run.gates.length === 0 && !run.pendingGate) {
    lines.push('(none)');
    return lines;
  }
  const seen = new Set<string>();
  const list = [...run.gates];
  if (run.pendingGate && !list.some((g) => g.id === run.pendingGate!.id)) {
    list.push(run.pendingGate);
  }
  for (const g of list) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const src = hitSources(g.hits);
    lines.push(
      `- ${g.status} ${g.trigger}: ${firstLine(g.reason)}${src}`,
    );
  }
  return lines;
}

/**
 * Required checks 节。
 * @param run run
 * @param config config
 * @returns 行
 */
function sectionRequired(run: RunState, config: SkegConfig): string[] {
  const lines = ['## Required checks'];
  const evaluation = evaluateClosure(run, config);
  const fromContract = new Set(requiredChecksFromContract(run, config));
  const signalOrigins = new Map<string, string>();
  for (const s of run.signals.filter((x) => x.revision === run.revision)) {
    for (const name of s.requiredChecks ?? []) {
      if (!signalOrigins.has(name)) {
        signalOrigins.set(name, `signal:${s.trigger}@r${s.revision}`);
      }
    }
  }

  const required = [
    ...new Set([
      ...fromContract,
      ...signalOrigins.keys(),
      ...evaluation.missing,
      ...evaluation.failed,
      ...evaluation.stale,
      ...evaluation.waived,
    ]),
  ].sort();

  if (required.length === 0) {
    lines.push('(none)');
    return lines;
  }

  const fresh = currentChecks(run);
  for (const name of required) {
    const origins: string[] = [];
    if (fromContract.has(name)) {
      origins.push(
        run.contract
          ? `contract.${run.risk === 'guarded' ? 'guardedChecks' : 'defaultChecks'}`
          : 'live-config',
      );
    }
    if (signalOrigins.has(name)) origins.push(signalOrigins.get(name)!);
    const origin = origins.length > 0 ? origins.join(' + ') : 'unknown';

    let status = 'missing';
    const cur = fresh.find((c) => c.name === name);
    if (cur?.passed) status = `fresh pass@r${cur.revision}`;
    else if (cur && !cur.passed) status = `failed@r${cur.revision}`;
    else if (evaluation.stale.includes(name)) {
      const old = run.checks
        .filter((c) => c.name === name && c.passed)
        .sort((a, b) => b.revision - a.revision)[0];
      status = `stale: passed@r${old?.revision ?? '?'}, current r${run.revision}`;
    } else if (evaluation.waived.includes(name)) {
      status = 'waived';
    }

    const src = cur?.source && cur.source !== 'builtin' ? ` [${cur.source}]` : '';
    lines.push(`- ${name}: from ${origin}; ${status}${src}`);
  }
  return lines;
}

/**
 * Waivers 节。
 * @param run run
 * @returns 行
 */
function sectionWaivers(run: RunState): string[] {
  const lines = ['## Waivers'];
  const w = currentWaiver(run);
  if (!w) {
    lines.push('(none for current revision)');
    return lines;
  }
  lines.push(
    `- r${w.revision}: ${w.reason} (covers: ${w.missingChecks.join(', ') || 'n/a'})`,
  );
  return lines;
}

/**
 * Contract drift 节。
 * @param run run
 * @param config config
 * @returns 行
 */
function sectionDrift(run: RunState, config: SkegConfig): string[] {
  const lines = ['## Contract drift'];
  if (!run.contract) {
    lines.push('No frozen contract (legacy session); live config used.');
    return lines;
  }
  const liveHash = configContractHash(config);
  const liveProviders = providersConfigHash(config.providers);
  const configDrift = liveHash !== run.contract.configHash;
  const providerDrift = liveProviders !== run.contract.providerSetHash;
  if (!configDrift && !providerDrift) {
    lines.push(
      `None. configHash=${shortHash(run.contract.configHash)} providerSetHash=${shortHash(run.contract.providerSetHash)}`,
    );
    return lines;
  }
  lines.push(
    `Drift detected. run.configHash=${shortHash(run.contract.configHash)} live=${shortHash(liveHash)}`,
  );
  lines.push(
    `run.providerSetHash=${shortHash(run.contract.providerSetHash)} live=${shortHash(liveProviders)}`,
  );
  lines.push(
    ...diffList(
      'defaultChecks',
      run.contract.defaultChecks,
      config.checks.default,
    ),
  );
  lines.push(
    ...diffList(
      'guardedChecks',
      run.contract.guardedChecks,
      config.checks.guarded,
    ),
  );
  return lines;
}

/**
 * 列表 diff 行。
 * @param label 标签
 * @param from 契约
 * @param to 当前
 * @returns 行
 */
function diffList(label: string, from: string[], to: string[]): string[] {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  const added = to.filter((x) => !fromSet.has(x));
  const removed = from.filter((x) => !toSet.has(x));
  if (added.length === 0 && removed.length === 0) {
    return [`${label}: (unchanged)`];
  }
  const parts: string[] = [];
  if (added.length) parts.push(`+${added.join(',+')}`);
  if (removed.length) parts.push(`-${removed.join(',-')}`);
  return [`${label}: ${parts.join(' ')}`];
}

/**
 * hit source 后缀。
 * @param hits hits
 * @returns 文本
 */
function hitSources(
  hits: Array<{ source?: string }>,
): string {
  const srcs = [
    ...new Set(
      hits.map((h) => h.source ?? 'builtin').filter(Boolean),
    ),
  ];
  if (srcs.length === 0) return '';
  return ` [source: ${srcs.join(', ')}]`;
}

/**
 * 首行截断。
 * @param text 文本
 * @returns 首行
 */
function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 160);
}

/**
 * hash 短前缀。
 * @param hash hex
 * @returns 前 12 字符
 */
function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
