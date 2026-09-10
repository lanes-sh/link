import { isToolResult } from '#connectivity';
import type { DispatchOutcome } from '#dispatch';
import { type ExpandArgument, expandMode, fill, noteFor, referencesIn, sibling } from './expand.ts';
import type { MergedCapability } from './visibility.ts';

export { EXPAND, type ExpandArgument } from './expand.ts';

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
 * It is also why the projection is merged *here* rather than at the seam in
 * `invoke` where `redact` is read. The dispatcher logs `request.arguments` and
 * sends `request.arguments`; arguments injected below that seam would make the
 * audit row and the wire disagree about what was asked for. Building them into
 * the request keeps the row true, and keeps a direct call to the same `.get`
 * answering with what the vendor's own default returns rather than quietly
 * receiving less than the caller asked for.
 *
 * What that costs: only calls arriving through `lanes_tools_call` are filled in.
 * Under `surface: crunched` that is every provider call, which is the case this
 * was built for. Under `full` a typed tool still returns what the provider
 * returned.
 */
export interface ExpandRequest {
  /** The list capability that was called. */
  readonly capability: string;
  /** What it answered with. */
  readonly result: unknown;
  /** What the caller asked for, if anything. */
  readonly asked: ExpandArgument | undefined;
  /** Everything this caller can reach, which is where the sibling and its projection live. */
  readonly merged: ReadonlyMap<string, MergedCapability>;
  /** The list's own arguments, which the follow-up inherits. */
  readonly listArguments: Readonly<Record<string, unknown>>;
  /** One ordinary top-level call, exactly as the caller's own would be. */
  readonly dispatch: (
    capabilityId: string,
    args: Record<string, unknown>,
  ) => Promise<DispatchOutcome>;
}

export async function expandIfReferences(
  request: ExpandRequest,
): Promise<{ content: { type: 'text'; text: string }[] } | undefined> {
  const mode = expandMode(request.asked);
  if (mode === undefined) return undefined;

  const paired = sibling(request.capability, request.merged);
  if (paired === undefined) return undefined;
  if (!isToolResult(request.result as never)) return undefined;

  const references = referencesIn(textOf(request.result));
  if (!references) return undefined;

  // `full` merges nothing, so a caller who wants the vendor's own default
  // representation has a way to say so.
  const projection = mode === 'compact' ? (request.merged.get(paired)?.compact ?? {}) : {};

  const { rows, fetched } = await fill(references.rows, async (id) => {
    const outcome = await request.dispatch(paired, {
      ...request.listArguments,
      ...projection,
      id,
    });
    if (!outcome.ok || !isToolResult(outcome.result)) return undefined;
    return textOf(outcome.result);
  });

  // The whole body, not just the array: a page token or a total sat beside it,
  // and replacing the body with the rows threw those away — which is what made
  // the old note's advice impossible to act on.
  const body = { ...references.body, [references.at]: rows };
  const note = noteFor(mode, paired, references.rows.length - fetched);

  return { content: [{ type: 'text' as const, text: `${JSON.stringify(body, null, 2)}${note}` }] };
}

/** The text of a tool result, with non-text blocks left out. */
function textOf(result: unknown): string {
  const blocks = (result as { content?: { type?: string; text?: string }[] }).content ?? [];
  return blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}
