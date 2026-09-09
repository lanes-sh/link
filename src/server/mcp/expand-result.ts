import { isToolResult } from '#connectivity';
import type { DispatchOutcome } from '#dispatch';
import { fill, referencesIn, sibling } from './expand.ts';
import type { MergedCapability } from './visibility.ts';

export { sibling };

/**
 * The gateway's half of filling in a list of references.
 *
 * Split from `expand.ts` so the decisions — is this a list, are these
 * references, how many is too many — stay testable without a dispatcher, and
 * the part that needs one stays small.
 *
 * **Why here and not in the dispatcher.** Expanding is re-entrancy: one call
 * becoming several, each of which must be authorised, redacted, rate-limited
 * and audited on its own. Doing that inside `invoke` means `invoke` calls
 * itself, and every deadline, limit and audit invariant in that function has to
 * be re-argued for the nested case. Doing it here means each follow-up is an
 * ordinary top-level call that the dispatcher cannot tell from any other — which
 * is also the honest description of what it is, since the provider being called
 * cannot tell either.
 *
 * What that costs: only calls arriving through `lanes_tools_call` are filled in.
 * Under `surface: crunched` that is every provider call, which is the case this
 * was built for. Under `full` a typed tool still returns what the provider
 * returned.
 */
export async function expandIfReferences(
  capability: string,
  result: unknown,
  wanted: boolean,
  merged: Map<string, MergedCapability>,
  fetch: (id: string) => Promise<DispatchOutcome>,
): Promise<{ content: { type: 'text'; text: string }[] } | undefined> {
  if (!wanted) return undefined;
  if (sibling(capability, merged) === undefined) return undefined;
  if (!isTool_(result)) return undefined;

  const text = textOf(result);
  const references = referencesIn(text);
  if (!references) return undefined;

  const { filled, capped } = await fill(references.ids, async (id) => {
    const outcome = await fetch(id);
    if (!outcome.ok || !isToolResult(outcome.result)) return undefined;
    return textOf(outcome.result);
  });

  const note =
    capped > 0
      ? `\n\n${capped} further row${capped === 1 ? '' : 's'} came back as identifiers only and were ` +
        'not fetched. Narrow the list, or call the get capability for the ones you want.'
      : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: `${JSON.stringify({ [references.at]: filled }, null, 2)}${note}`,
      },
    ],
  };
}

/** Whether a dispatch result is a tool result at all. */
function isTool_(result: unknown): boolean {
  return isToolResult(result as never);
}

/** The text of a tool result, with non-text blocks left out. */
function textOf(result: unknown): string {
  const blocks = (result as { content?: { type?: string; text?: string }[] }).content ?? [];
  return blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}
