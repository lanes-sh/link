import type { ToolResult } from '#connectivity';

/**
 * What an upstream's answer becomes.
 *
 * Since #202 this endpoint advertises an upstream's output schema as its own,
 * on the claim that it hands the upstream's result back unchanged. Two things
 * made that untrue:
 *
 * - **Every block that was not text** became a link whose `uri` was read off
 *   the block's top level, where only a link has one. So an embedded resource
 *   or an image arrived as a link to the empty string, with its content gone.
 * - **`structuredContent` was never read at all.** A tool that declares an
 *   output schema must answer with data that fits it, so every successful call
 *   to one was refused on the way out as a validation error.
 *
 * Its own file for the reason `refused.ts` gives: `index.ts` is at the budget,
 * and this is a subject rather than a line.
 */

/** An upstream's answer to `tools/call`, as the client library hands it over. */
export interface UpstreamResult {
  readonly content?: readonly UpstreamBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** An upstream's whole answer, as a `ToolResult`. */
export function handedBack(result: UpstreamResult): ToolResult {
  const data = result.structuredContent;

  return {
    content: (result.content ?? []).map(carried),
    ...(typeof data === 'object' && data !== null && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

/** A content block as an upstream may send one: any type the protocol has. */
export interface UpstreamBlock {
  readonly type: string;
  readonly text?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly data?: string;
  readonly resource?: {
    readonly uri?: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
  };
}

/**
 * One upstream block, as a `ToolResult` can hold it.
 *
 * An embedded resource holding text is the answer itself — GitHub returns a
 * file's contents that way — so it is handed back as text. Anything binary is
 * described in one line rather than carried: putting its bytes in front of the
 * model is the cost ADR-017 exists to avoid.
 */
export function carried(block: UpstreamBlock): ToolResult['content'][number] {
  if (block.type === 'text') return { type: 'text', text: block.text ?? '' };

  // The vendor's own link, exactly as written: `routing.ts` routes only this
  // endpoint's origins, and inserting segments into someone else's URL would
  // corrupt it.
  if (block.type === 'resource_link' && block.uri) {
    return { type: 'resource_link', uri: block.uri, ...(block.name ? { name: block.name } : {}) };
  }

  if (block.type === 'resource' && typeof block.resource?.text === 'string') {
    return { type: 'text', text: block.resource.text };
  }

  const base64 = block.data ?? block.resource?.blob;
  const facts = [
    block.resource?.uri ?? block.uri ?? block.type,
    block.mimeType ?? block.resource?.mimeType,
    base64 === undefined ? undefined : `${bytesIn(base64)} bytes`,
  ].filter((fact) => fact !== undefined && fact !== '');

  return {
    type: 'text',
    text: `[${facts.join(', ')}] — not carried: this endpoint hands back text and links.`,
  };
}

/** How many bytes a base64 string decodes to, without decoding it. */
function bytesIn(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
