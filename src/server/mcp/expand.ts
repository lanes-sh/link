import type { MergedCapability } from './visibility.ts';

/**
 * Filling in a list that came back as references.
 *
 * The one hop no amount of ranking removes. A mail API asked for messages
 * answers with `{id, threadId}` and nothing readable, so "what is the last
 * email" is two calls however well the first one was found: list, then get. The
 * problem has a name — N+1 — and so does the fix, which every large API
 * eventually ships: Stripe calls it `expand`, OData and Graph call it
 * `$expand`, GraphQL solves it by construction.
 *
 * **Where this differs from all of them, and it is the contested part.** Those
 * make the caller ask. This decides. The reason is that an agent which has to
 * *know* to ask is back to needing a round trip to find that out, which is the
 * cost being removed — but it means spending someone else's rate limit on an
 * inference, and that is a real objection rather than a hypothetical one. Three
 * things keep it honest: the detection is strict enough that a false positive
 * is close to impossible, the fan-out is small and reported, and `expand:
 * false` turns it off.
 *
 * Derived, never declared. The pairing comes from the names — a rule that finds
 * every list/get sibling across the vendored surface and nothing spurious — and
 * whether a list actually returned references is read off the response, because
 * the specs here do not say (`vendor-spec.ts` explains why they cannot).
 */

/** The most rows filled in for one call, however many came back. */
const MOST = 5;

/** How many at once. Bounded because they are somebody else's API. */
const AT_ONCE = 3;

/**
 * The capability that turns one of these references into a record.
 *
 * `<prefix>.list` pairs with `<prefix>.get`, which is the convention Google's
 * own API guidelines define as standard methods and which the vendored surface
 * follows exactly. A provider that does not follow it simply never pairs.
 */
export function sibling(id: string, reachable: ReadonlyMap<string, MergedCapability>): string | undefined {
  const paired = id.endsWith('.list') ? `${id.slice(0, -'.list'.length)}.get` : undefined;
  return paired !== undefined && reachable.has(paired) ? paired : undefined;
}

/**
 * The references in a list result, if that is what it holds.
 *
 * Strict on purpose, because being wrong here spends the owner's API quota on
 * a guess. Every one of these must hold:
 *
 *   - the body parses as a JSON object;
 *   - exactly one of its properties is a non-empty array of objects;
 *   - every row has at most two keys, and one of them is `id`.
 *
 * A row carrying a subject, or a date, or anything else a reader could use is
 * not a reference — it is the record already, and filling it in would be a
 * second call for something already in hand. `calendar.events.list` returns
 * whole events and is left alone by exactly this test.
 */
export function referencesIn(text: string): { at: string; ids: string[] } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const arrays = Object.entries(body as Record<string, unknown>).filter(
    ([, value]) => Array.isArray(value) && value.length > 0,
  );
  if (arrays.length !== 1) return undefined;

  const [at, rows] = arrays[0] as [string, unknown[]];
  const ids: string[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
    const keys = Object.keys(row as Record<string, unknown>);
    if (keys.length > 2 || !keys.includes('id')) return undefined;
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id !== 'string') return undefined;
    ids.push(id);
  }

  return ids.length > 0 ? { at, ids } : undefined;
}

/**
 * Run the follow-ups, a few at a time.
 *
 * Each one goes through the same dispatcher as any other call, so it is
 * authorised, redacted, rate-limited and audited exactly as though the caller
 * had made it — which, in every sense that matters to the provider being
 * called, they did. A row that fails is left as the reference it was rather
 * than failing the call that found it.
 */
export async function fill(
  ids: readonly string[],
  fetch: (id: string) => Promise<string | undefined>,
): Promise<{ filled: unknown[]; capped: number }> {
  const wanted = ids.slice(0, MOST);
  const filled: unknown[] = new Array(wanted.length);

  for (let start = 0; start < wanted.length; start += AT_ONCE) {
    const batch = wanted.slice(start, start + AT_ONCE);
    const done = await Promise.all(batch.map(async (id) => fetch(id)));

    done.forEach((text, offset) => {
      const at = start + offset;
      if (text === undefined) {
        filled[at] = { id: wanted[at] };
        return;
      }
      try {
        filled[at] = JSON.parse(text);
      } catch {
        filled[at] = { id: wanted[at], result: text };
      }
    });
  }

  return { filled, capped: ids.length - wanted.length };
}
