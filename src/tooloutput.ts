/**
 * 从宿主 tool_result.content 提取纯文本。
 * @param content 工具输出
 * @returns 文本
 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      typeof c === 'string'
        ? c
        : typeof c === 'object' && c && 'text' in c
          ? String((c as { text?: unknown }).text ?? '')
          : '',
    )
    .join('\n');
}
