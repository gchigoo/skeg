/**
 * 宿主 session 级可变状态（跨 Pi 扩展模块共享，依赖 ESM 模块缓存）。
 * core 与 compat 都从此处读写，避免扁平命令与事件钩子状态分叉。
 */
import { PendingMutationTable } from './pending.ts';

/** 本 session 已确认的 gate acknowledgement keys */
export const acknowledgedGates = new Set<string>();

/** 本 session 挂起的 mutation（toolCallId → 期望路径） */
export const pendingMutations = new PendingMutationTable();

/**
 * 清空宿主 session 状态（新 /run 开始时调用）。
 */
export function clearHostSession(): void {
  acknowledgedGates.clear();
  pendingMutations.clear();
}
