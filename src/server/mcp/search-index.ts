import { z } from 'zod';
import { queryTerms } from './query.ts';
import { type Match, rank } from './ranking.ts';
import { afford, type Accounts, DEFAULT, renderMatches } from './render.ts';
import { scoreEntry, searchable, shapeOf } from './searchable.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * Finding a capability by keyword, and saying enough about it to call.
 *
 * The half of the stable-name surface that is a pure function of the merged
 * capability set — no server, no dispatcher, no principal. `search.ts` serves
 * it; this decides what the answer is, which is why the two are separate files:
 * ranking and rendering are the part worth testing against a fixture, and
 * everything in `search.ts` needs a wired endpoint to exercise at all.
 *
 * See `search.ts` for what the surface is for and why it exists (ADR-075).
 */

/**
 * Search, rendered.
 *
 * One entry point, because the caller is a tool handler and the only thing it
 * has to decide is what text to return.
 */
export function searchCapabilities(
  query: string,
  merged: Map<string, MergedCapability>,
  surface?: 'full' | 'crunched',
  filters: Filters = {},
  accounts?: Accounts,
): string {
  return renderMatches(
    query,
    select(query, merged, filters),
    surface,
    filters.limit ?? DEFAULT,
    accounts,
  );
}

/**
 * Both halves of one answer, off one ranking.
 *
 * The tool returns prose and a structured copy of the same search, and asking
 * for them separately ranked the whole reachable set twice for a single
 * question: two passes to find the candidates, two more to weigh every term
 * against each of them, and `shapeOf` converting the same Zod schemas again on
 * the way out. Neither pass could see the other's work, and both were answering
 * the same query with the same filters.
 *
 * `searchCapabilities` and `searchResults` stay as they are, because the corpus
 * is the useful thing to hand a test. This is what the handler calls.
 */
export function searchAnswer(
  query: string,
  merged: Map<string, MergedCapability>,
  surface: 'full' | 'crunched' | undefined,
  filters: Filters = {},
  accounts?: Accounts,
): { text: string; structured: SearchResults } {
  const matches = select(query, merged, filters);
  const limit = filters.limit ?? DEFAULT;

  return {
    text: renderMatches(query, matches, surface, limit, accounts),
    structured: resultsFrom(query, matches, limit, accounts),
  };
}

/**
 * The same answer as data, for a client that would rather not parse prose.
 *
 * `tools/call` may carry `structuredContent` beside its text since the
 * 2026-07-28 revision, and a search result is the strongest case for it on this
 * endpoint: its whole purpose is to be read and turned into the *next* call, so
 * every field a client has to recover with a regular expression is a chance to
 * recover it wrongly. The text stays — it is what a model reads, and older
 * clients get nothing else.
 */
export function searchResults(
  query: string,
  merged: Map<string, MergedCapability>,
  filters: Filters = {},
  accounts?: Accounts,
): SearchResults {
  return resultsFrom(query, select(query, merged, filters), filters.limit ?? DEFAULT, accounts);
}

/** The shape `searchResults` and `searchAnswer` both answer with. */
export type SearchResults = {
  query: string;
  matched: number;
  reachable: { profile: string; connections: { connection: string; account: string }[] }[];
  capabilities: {
    capability: string;
    tool: string;
    title: string | undefined;
    description: string;
    reads: boolean;
    reachable: { profile: string; connections: string[] }[];
    inputSchema: Record<string, unknown>;
  }[];
};

/** The structured answer, off a ranking that has already been done. */
function resultsFrom(
  query: string,
  matches: Match[],
  limit: number,
  accounts?: Accounts,
): SearchResults {
  const { detailed } = afford(matches, limit);

  return {
    query,
    matched: matches.length,
    // The same box the prose carries, as data. A caller building the next call
    // needs a profile and a connection for it, and this is where both are.
    reachable: [...(accounts ?? new Map())].map(([profile, connections]) => ({
      profile,
      connections: [...connections].map(([connection, account]) => ({ connection, account })),
    })),
    capabilities: detailed.map((match) => {
      const shape = shapeOf(match.entry);
      return {
        capability: match.id,
        tool: match.tool,
        title: shape.title,
        description: shape.description.split('\n\nAvailable connections')[0] ?? '',
        reads: match.entry.reads,
        reachable: [...match.entry.reachable].map(([profile, connections]) => ({
          profile,
          connections: [...connections],
        })),
        inputSchema: shape.inputSchema,
      };
    }),
  };
}

/**
 * The arguments a capability accepts, as the search would print them.
 *
 * Exported so the gateway can validate against exactly what it advertised. A
 * second derivation of "what this takes" would let the two disagree, and the
 * disagreement would read as the caller getting the schema wrong.
 */
export function schemaFor(entry: MergedCapability): Record<string, unknown> {
  return shapeOf(entry).inputSchema;
}

/**
 * The shape `searchResults` promises, as the tool advertises it.
 *
 * Beside the function that produces it rather than beside the registration that
 * publishes it, because the specification requires a server to conform to an
 * output schema it declares — and a schema kept next to the declaration drifts
 * from the code that has to satisfy it.
 */
export const SEARCH_RESULT = {
        query: z.string(),
        matched: z.number().int().describe('How many capabilities matched, including any not explained below.'),
        capabilities: z.array(
          z.object({
            capability: z.string().describe('The id to pass to lanes_tools_call.'),
            tool: z.string().describe('The tool name, if this endpoint advertises one for it.'),
            title: z.string().optional(),
            description: z.string(),
            reads: z
              .boolean()
              .describe(
                'Whether this only reads, as its provider classified it. False where the provider did not say.',
              ),
            reachable: z
              .array(z.object({ profile: z.string(), connections: z.array(z.string()) }))
              .describe('Where it can be called, and as which account.'),
            inputSchema: z
              .record(z.string(), z.unknown())
              .describe('Its arguments. `profile` and `connection` are added by this endpoint.'),
          }),
        ),
};

/**
 * What a caller may narrow a search by, beyond the words.
 *
 * All optional, and none of them can widen what is reachable — they filter the
 * ranking, which was already built only from what this caller may reach. A
 * filter naming something they cannot reach returns nothing, which is the same
 * answer they would get for a capability that does not exist (ADR-007).
 *
 * `readOnly` narrows on `entry.reads`, which is the provider's own
 * classification, and not on the reading of the capability's name that `fit`
 * uses to order results. Ordering may guess; a caller asking to be shown only
 * the safe operations is relying on the answer, so where the provider said
 * nothing this says nothing either and the capability is left out.
 */
export type Filters = {
  readonly provider?: string | undefined;
  readonly profile?: string | undefined;
  readonly connection?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly limit?: number | undefined;
};

/** The ranking, narrowed by whatever the caller pinned down. */
function select(
  query: string,
  merged: Map<string, MergedCapability>,
  filters: Filters,
): Match[] {
  return rank(query, merged).filter((match) => {
    if (filters.provider !== undefined && match.id.split('.')[0] !== filters.provider) return false;
    if (filters.readOnly === true && !match.entry.reads) return false;
    if (filters.profile !== undefined && !match.entry.reachable.has(filters.profile)) return false;
    if (filters.connection !== undefined) {
      const named = [...match.entry.reachable.values()].some((all) =>
        all.includes(filters.connection as string),
      );
      if (!named) return false;
    }
    return true;
  });
}

/**
 * Whether anything at all would come back for this query.
 *
 * `searchCapabilities` renders "Nothing reachable matches" from an empty
 * ranking, and that sentence is a claim about what this *instance* holds rather
 * than about the account. An instance that missed the notify (ADR-029) makes it
 * about a provider connected minutes ago, and it is the answer a model acts on:
 * a search is how anything outside the owner layer is found under
 * `surface: crunched`, so a wrong miss here ends the attempt before a call is
 * ever composed.
 *
 * So the endpoint asks this before dispatching a search, and treats a miss the
 * way it already treats a call naming a tool it does not serve — see
 * `Generation.knows`.
 *
 * The same ranking `rank` runs, stopped at the first hit instead of sorted.
 * A query that matches costs a partial pass and no reload; only one that
 * matches nothing pays for the whole pass, and that is the query about to cost
 * a network round trip regardless.
 */
export function matchesQuery(
  query: string,
  merged: ReadonlyMap<string, MergedCapability>,
): boolean {
  if (merged.has(query.trim())) return true;

  const terms = queryTerms(query);
  if (terms.length === 0) return false;

  for (const [id, entry] of merged) {
    if (!searchable(entry)) continue;
    if (scoreEntry(id, entry, terms) > 0) return true;
  }

  return false;
}
