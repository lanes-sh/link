import type { ToolResult } from '#connectivity';

/** The two result shapes every operation returns. */

export function error(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
