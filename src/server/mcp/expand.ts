import { z } from 'zod';
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
 * is close to impossible, the fan-out is bounded and reported, and `expand:
 * false` turns it off.
 *
 * Derived, never declared. The pairing comes from the names — a rule that finds
 * every list/get sibling across the vendored surface and nothing spurious — and
 * whether a list actually returned references is read off the response, because
 * the specs here do not say (`vendor-spec.ts` explains why they cannot).
 *
 * **What deciding cost, the first time it met a real mailbox.** Five rows came
 * back as 193,271 characters and overflowed the reply, because a row was filled
 * in at whatever representation the vendor defaults to and a Gmail message's
 * default carries every `Received:` hop, the DKIM and ARC headers, and the body
 * as base64. Two further rows were dropped to fit, and the note explaining that
 * told the caller to fetch them itself — from an array the fill had already
 * replaced, so the identifiers to do it with were gone.
 *
 * Three things follow, and none of them is the decision above.
 *
 * **A count was the wrong unit**, which `render.ts` had already worked out one
 * file away for search answers: five rows is a few kilobytes of one provider's
 * records and two hundred of another's, so a fixed number either truncates the
 * useful answer or floods the context, and which it does depends on whose API
 * the caller happened to ask about. The bound is bytes.
 *
 * **A row has to be worth filling in.** A vendor that will answer with a
 * summary should be asked for one, and most will: `compact` merges the
 * projection arguments the provider declared (`manifest.compact`) into the
 * follow-up, so the saving happens at the source rather than by trimming a
 * response we already paid to receive. That is what makes filling in *every*
 * row affordable, which is the shape the caller wanted in the first place.
 *
 * **Nothing is dropped.** Every reference the list returned comes back, filled
 * or not, and an unfilled one comes back exactly as the vendor wrote it — so
 * the note telling a caller to fetch the rest is one it can act on.
 *
 * The only difference between `compact` and `full` is which arguments are
 * merged. Both are bounded the same way, because the reported failure *is*
 * `full` semantics with a row cap instead of a byte cap: exempting it would
 * leave the bug in place for anyone who asked for it by name.
 */

/**
 * What a filled-in reply may cost, in bytes of the caller's context.
 *
 * Deliberately not shared with `render.ts`'s budget. They bound different
 * things — a search answer against a capability result — and that file can
 * price an entry before spending it because it holds the schema, while this one
 * has to fetch a row to learn its size. One number serving both would mean
 * tuning the search surface silently changed how much mail came back.
 */
const BUDGET = 32 * 1024;

/**
 * Always filled, however large.
 *
 * `render.ts` takes the same floor for the same reason: a reply that names an
 * identifier and withholds what it points at costs a round trip *and* looks
 * like an answer. It is also why the first row is fetched on its own — a record
 * big enough to spend the whole budget has to be seen to be measured, and a
 * first wave of three would have paid for three of them before anything could
 * check.
 */
const FEWEST = 1;

/**
 * The most rows filled in for one call, however small they are.
 *
 * No longer a bound on the caller's context — `BUDGET` is that — but on
 * somebody else's quota, which is the objection the header concedes. A profile
 * allows 60 upstream calls a minute by default, so one expansion may spend at
 * most a little over a third of them. In practice this ceiling is what binds
 * under `compact`, where rows are small, and the budget binds under `full`.
 */
const MOST = 25;

/** How many at once. Bounded because they are somebody else's API. */
const AT_ONCE = 3;

/** Whole records, or the smaller one the provider declared. */
export type ExpandMode = 'compact' | 'full';

/** What a caller may pass. `true` is accepted and never advertised — see `EXPAND`. */
export type ExpandArgument = boolean | ExpandMode;

/**
 * The argument, colocated with the rules that read it.
 *
 * `true` is accepted and deliberately undocumented. The shipped description
 * never told anyone to pass it, and the new one teaches `compact`, `full` and
 * `false` only — but `expand` was released as a boolean, and ADR-032 is the
 * record that a client which pinned its tool list at registration serves that
 * schema forever with no way for this endpoint to make it re-read. Refusing
 * `true` would break exactly the clients `lanes_tools_search` exists to rescue.
 * One spelling in the documentation, two in the parser, and the second is there
 * for a client that cannot be told.
 */
export const EXPAND = z
  .union([z.boolean(), z.enum(['compact', 'full'])])
  .optional()
  .describe(
    'Fill in a list that comes back as bare identifiers. "compact" (the default) asks the ' +
      'provider for a summary of every row; "full" asks for whole records and fills in fewer. ' +
      'Pass false for the identifiers exactly as the provider returned them.',
  );

/** Which representation to fill in with, or nothing when the caller declined. */
export function expandMode(asked: ExpandArgument | undefined): ExpandMode | undefined {
  if (asked === false) return undefined;
  return asked === 'full' ? 'full' : 'compact';
}

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

/** A list body that holds nothing but references, and the rows themselves. */
export interface References {
  /** The property the array sat under. */
  readonly at: string;
  /** The reference objects, exactly as the vendor wrote them. */
  readonly rows: readonly Record<string, unknown>[];
  /** The whole body, so its siblings — a page token, a total — survive the fill. */
  readonly body: Record<string, unknown>;
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
export function referencesIn(text: string): References | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const record = body as Record<string, unknown>;
  const arrays = Object.entries(record).filter(
    ([, value]) => Array.isArray(value) && value.length > 0,
  );
  if (arrays.length !== 1) return undefined;

  const [at, rows] = arrays[0] as [string, unknown[]];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
    const keys = Object.keys(row as Record<string, unknown>);
    if (keys.length > 2 || !keys.includes('id')) return undefined;
    if (typeof (row as Record<string, unknown>)['id'] !== 'string') return undefined;
  }

  return { at, rows: rows as Record<string, unknown>[], body: record };
}

/**
 * Run the follow-ups, a few at a time, until the budget or the ceiling stops it.
 *
 * Each one goes through the same dispatcher as any other call, so it is
 * authorised, redacted, rate-limited and audited exactly as though the caller
 * had made it — which, in every sense that matters to the provider being
 * called, they did. A row that fails is left as the reference it was rather
 * than failing the call that found it, and counts as unfilled, so the note at
 * the end is about what the caller actually holds rather than what was tried.
 *
 * The budget is checked between waves rather than within one, so a reply may
 * overshoot by up to `AT_ONCE - 1` rows. Serialising the fetches to make it
 * exact would cost a round trip per row to save a few kilobytes of a bound that
 * is itself a judgement.
 */
export async function fill(
  references: readonly Record<string, unknown>[],
  fetch: (id: string) => Promise<string | undefined>,
): Promise<{ rows: unknown[]; fetched: number }> {
  // Seeded from the references, so every position is present by construction
  // and an unfilled one is the vendor's own object rather than a rebuild of it.
  const rows: unknown[] = [...references];
  const ceiling = Math.min(references.length, MOST);

  let spent = 0;
  let fetched = 0;
  let at = 0;

  while (at < ceiling) {
    const width = at < FEWEST ? FEWEST : AT_ONCE;
    const batch = references.slice(at, at + width);
    const done = await Promise.all(batch.map(async (row) => fetch(row['id'] as string)));

    done.forEach((text, offset) => {
      if (text === undefined) return;
      spent += text.length;
      fetched += 1;
      try {
        rows[at + offset] = JSON.parse(text);
      } catch {
        rows[at + offset] = { ...references[at + offset], result: text };
      }
    });

    at += width;
    if (spent >= BUDGET) break;
  }

  return { rows, fetched };
}

/**
 * What to say about the rows that are still identifiers.
 *
 * Names the capability that turns one into a record, because the caller would
 * otherwise have to search for it, and — under `full` — names the other mode,
 * because asking for less is usually the better answer to "there were more of
 * them". It says nothing about paging: the vendor's own page token is back in
 * the body now, and guessing which key is one would be vendor knowledge dressed
 * up as a heuristic.
 */
export function noteFor(mode: ExpandMode, getCapability: string, left: number): string {
  if (left <= 0) return '';

  const rows = `${left} further row${left === 1 ? '' : 's'}`;
  const byHand = `call ${getCapability} for the ones you want`;

  return mode === 'full'
    ? `\n\n${rows} came back as identifiers only, because whole records are large. ` +
        `Pass expand: "compact" to fill in every row at once, or ${byHand}.`
    : `\n\n${rows} came back as identifiers only. Narrow the list, or ${byHand}.`;
}
