/**
 * veritack/context 审计载荷：默认摘要，debug 全量。
 */
import { estimateTokens } from './inject.ts';

export type ContextAuditPayload = {
  hash: string;
  tokens: number;
  content?: string;
};

/**
 * 构建注入审计 entry 载荷。
 * @param content 注入文本
 * @param hash sha256 hex
 * @param auditMode 环境值（默认读 VERITACK_CONTEXT_AUDIT）
 * @returns 载荷
 */
export function buildContextAuditPayload(
  content: string,
  hash: string,
  auditMode: string | undefined = process.env.VERITACK_CONTEXT_AUDIT,
): ContextAuditPayload {
  const tokens = estimateTokens(content);
  if (auditMode === 'full') {
    return { hash, tokens, content };
  }
  return { hash, tokens };
}
