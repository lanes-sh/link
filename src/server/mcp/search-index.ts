import { isTool } from '#connectivity';
import { z } from 'zod';
import { toolNameFor } from './naming.ts';
import { queryTerms, reads } from './query.ts';
import { type Match, rank } from './ranking.ts';
import { afford, type Accounts, DEFAULT, renderMatches } from './render.ts';
import { sanitizeSchema } from './schema.ts';
import { scoreEntry, searchable, summaryOf } from './searchable.ts';
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
 * What an answer may cost, in bytes of the caller's context.
 *
 * A count was the wrong unit. Five matches is 900 bytes of one provider's
 * schemas and 40 KB of another's, so a fixed number either truncates the useful
 * answer or floods the context — and which it does depends on whose API the
 * caller happened to ask about.
 */
const BUDGET = 16 * 1024;

/** The most any one query will explain, however small the schemas are. */
const MOST = 10;

/**
 * The fewest, however large.
 *
 * The best match is rendered in full even when it alone exceeds the budget. An
 * answer that names the right capability and withholds its arguments is the
 * expensive kind of wrong: it costs a round trip *and* looks like an answer.
 */
const FEWEST = 1;

/** What one capability's title, description and schema are, whichever kind it is. */
export function shapeOf(entry: MergedCapability): {
  title: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const summary = summaryOf(entry);

  if (entry.discovered) {
    return { ...summary, inputSchema: sanitizeSchema(entry.discovered.inputSchema) };
  }

  const capability = entry.capability;
  if (!capability || !isTool(capability)) return { ...summary, inputSchema: { type: 'object' } };

  // Authored capabilities carry Zod, so the JSON Schema a caller needs is
  // derived here rather than stored. `registerLocalTool` hands the SDK the Zod
  // shape and lets it do the same conversion, so this is the same schema by a
  // different route — not a second definition of it.
  let inputSchema: Record<string, unknown> = { type: 'object' };
  try {
    inputSchema = z.toJSONSchema(capability.inputSchema as z.ZodType) as Record<string, unknown>;
  } catch {
    // A schema Zod will not convert is still a callable tool, and a search that
    // threw would take out every other result with it.
  }

  return { ...summary, inputSchema };
}



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
): {
  query: string;
  matched: number;
  reachable: { profile: string; connections: { connection: string; account: string }[] }[];
  capabilities: {
    capability: string;
    tool: string;
    title: string | undefined;
    description: string;
    reachable: { profile: string; connections: string[] }[];
    inputSchema: Record<string, unknown>;
  }[];
} {
  const matches = select(query, merged, filters);
  const { detailed } = afford(matches, filters.limit ?? DEFAULT);

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
    if (filters.readOnly === true && !reads(match.id)) return false;
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
