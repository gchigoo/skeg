/**
 * RunContract：启动时冻结验证要求，防止 run 中配置自我弱化。
 */
import { createHash } from 'node:crypto';
import { providersConfigHash } from './trust.ts';
import type { RunContract, RunState, SkegConfig } from './types.ts';

/**
 * 计算与验证契约相关的配置哈希（checks / policies / defaultPolicy）。
 * @param config 当前配置
 * @returns sha256 hex
 */
export function configContractHash(config: SkegConfig): string {
  const payload = {
    defaultPolicy: config.defaultPolicy,
    checks: {
      default: config.checks.default,
      guarded: config.checks.guarded,
      commands: config.checks.commands ?? null,
    },
    policies: config.policies,
  };
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * 从当前配置构建启动契约快照。
 * @param config 配置
 * @param createdAt 可选时间戳
 * @returns RunContract
 */
export function buildRunContract(
  config: SkegConfig,
  createdAt?: string,
): RunContract {
  return {
    schemaVersion: 1,
    configHash: configContractHash(config),
    providerSetHash: providersConfigHash(config.providers),
    defaultChecks: [...config.checks.default],
    guardedChecks: [...config.checks.guarded],
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

/**
 * 解析 closure / inject 用的 required check 基线（契约优先）。
 * @param run 当前 run
 * @param config 当前配置（无 contract 时回退）
 * @returns check 名列表
 */
export function requiredChecksFromContract(
  run: RunState,
  config: SkegConfig,
): string[] {
  if (run.contract) {
    return run.risk === 'guarded'
      ? run.contract.guardedChecks
      : run.contract.defaultChecks;
  }
  return run.risk === 'guarded'
    ? config.checks.guarded
    : config.checks.default;
}

/**
 * 判断当前配置相对 run contract 是否漂移。
 * @param run 当前 run
 * @param config 当前配置
 * @returns 是否漂移
 */
export function hasContractDrift(
  run: RunState | null,
  config: SkegConfig,
): boolean {
  if (!run?.contract) return false;
  return (
    configContractHash(config) !== run.contract.configHash ||
    providersConfigHash(config.providers) !== run.contract.providerSetHash
  );
}

/**
 * 契约漂移提示文案。
 * @returns 多行提示
 */
export function formatContractDriftHint(): string {
  return 'Contract drift: config changed; current run keeps its contract; abandon + restart to adopt.';
}
