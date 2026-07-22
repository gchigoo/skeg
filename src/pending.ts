/**
 * 短期内存：tool_call → tool_result 之间的 PendingMutation。
 */
import type { BashEffect } from './effects.ts';

export type PendingMutation = {
  toolCallId: string;
  expectedPaths: string[];
  effect: BashEffect | { kind: 'write' } | { kind: 'edit' };
};

/**
 * PendingMutation 表：按 toolCallId 索引。
 */
export class PendingMutationTable {
  private readonly map = new Map<string, PendingMutation>();

  /**
   * 登记预期 mutation。
   * @param pending 待确认 mutation
   */
  set(pending: PendingMutation): void {
    this.map.set(pending.toolCallId, pending);
  }

  /**
   * 取出并删除。
   * @param toolCallId 工具调用 id
   * @returns pending 或 undefined
   */
  take(toolCallId: string): PendingMutation | undefined {
    const value = this.map.get(toolCallId);
    if (value) this.map.delete(toolCallId);
    return value;
  }

  /** 清空全部（run 结束时）。 */
  clear(): void {
    this.map.clear();
  }
}
