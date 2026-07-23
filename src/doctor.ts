/**
 * /skeg doctor：只读诊断报告（config / trust / providers / run / env）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigWithDiagnostics } from './config.ts';
import {
  formatContractDriftHint,
  hasContractDrift,
} from './contract.ts';
import {
  formatProvidersStatus,
  type LoadedProviders,
} from './providers.ts';
import { readGitDiff } from './prove.ts';
import { formatStatus } from './run.ts';
import { loadTrustStoreWithDiagnostics, skegUserDir } from './trust.ts';
import type { RunState, SkegConfig } from './types.ts';

/**
 * 读取本包版本号。
 * @returns version 字符串
 */
export function readSkegVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export type DoctorInput = {
  cwd: string;
  run: RunState | null;
  config: SkegConfig;
  providers: LoadedProviders;
};

/**
 * 构建 doctor 诊断文本。
 * @param input 当前上下文
 * @returns 多行报告
 */
export function buildDoctorReport(input: DoctorInput): string {
  const lines: string[] = ['Skeg doctor', ''];

  // 环境
  const git = readGitDiff(input.cwd);
  lines.push('## Environment');
  lines.push(`- skeg: ${readSkegVersion()}`);
  lines.push(`- node: ${process.version}`);
  lines.push(
    `- git: ${git.available ? 'available' : `unavailable (${git.error ?? 'unknown'})`}`,
  );
  lines.push(`- userDir: ${skegUserDir()}`);
  lines.push('');

  // Config
  const loaded = loadConfigWithDiagnostics(input.cwd);
  lines.push('## Config');
  lines.push(`- source: ${loaded.source}`);
  lines.push(
    `- defaultPolicy: ${loaded.config.defaultPolicy}; guidance: ${loaded.config.guidance}`,
  );
  lines.push(
    `- checks.default: ${loaded.config.checks.default.join(', ') || '(none)'}`,
  );
  lines.push(
    `- checks.guarded: ${loaded.config.checks.guarded.join(', ') || '(none)'}`,
  );
  if (loaded.diagnostics.length === 0) {
    lines.push('- diagnostics: (none)');
  } else {
    lines.push('- diagnostics:');
    for (const d of loaded.diagnostics) {
      lines.push(
        `  - ${d.level}${d.path ? ` (${d.path})` : ''}: ${d.message}`,
      );
    }
  }
  lines.push('');

  // Trust store
  const trust = loadTrustStoreWithDiagnostics();
  lines.push('## Trust store');
  if (trust.diagnostics.length === 0) {
    lines.push(`- status: ok (${trust.store.providers.length} record(s))`);
  } else {
    lines.push('- status: issues');
    for (const d of trust.diagnostics) {
      lines.push(`  - ${d.level}: ${d.message}`);
    }
    if (trust.corruptBackup) {
      lines.push(`- corruptBackup: ${trust.corruptBackup}`);
    }
  }
  lines.push('');

  // Providers
  lines.push('## Providers');
  lines.push(
    formatProvidersStatus(input.cwd, loaded.config, input.providers),
  );
  lines.push('');

  // Run
  lines.push('## Run');
  lines.push(formatStatus(input.run));
  if (hasContractDrift(input.run, loaded.config)) {
    lines.push(formatContractDriftHint());
  }

  return lines.join('\n').trim();
}
