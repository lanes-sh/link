import { isTool } from '#connectivity';
import { z } from 'zod';
import { toolNameFor } from './naming.ts';
import { queryTerms } from './query.ts';
import { type Match, rank } from './ranking.ts';
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

/** How many matches come back with their whole schema attached. */
const DETAILED = 5;

/** How many come back as a line each, after those. */
const LISTED = 20;

/** What one capability's title, description and schema are, whichever kind it is. */
function shapeOf(entry: MergedCapability): {
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



/** Where a capability can be used, as the search reports it. */
function whereReachable(entry: MergedCapability): string {
  return [...entry.reachable]
    .map(([profile, connections]) => `${profile}: ${connections.join(', ')}`)
    .join(' | ');
}

function renderMatches(
  query: string,
  matches: readonly Match[],
  surface?: 'full' | 'crunched',
): string {
  if (matches.length === 0) {
    return (
      `Nothing reachable matches "${query}".\n\n` +
      'This searched every capability this caller can reach, so a miss means it is ' +
      'not connected or not granted rather than not spelled right. ' +
      'Call lanes_setup_overview for what is connected and what connecting something else takes.'
    );
  }

  const detailed = matches.slice(0, DETAILED);
  const listed = matches.slice(DETAILED, DETAILED + LISTED);

  const lines: string[] = [
    `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}".`,
    '',
    // Why the tool is missing differs by mode, and the reason is the part a
    // model acts on. Under `full` an absent tool means the client's list is
    // stale; under `crunched` it means the endpoint never advertised it and
    // never will, so telling the model to prefer a named tool would be telling
    // it to wait for something that is not coming.
    surface === 'crunched'
      ? 'This endpoint advertises a small surface on purpose: the owner layer and these two ' +
        'tools. Everything below is reachable through lanes_tools_call and will not appear in ' +
        'your tool list, so call it with the capability id and the arguments shown.'
      : 'Each one is invocable two ways. Prefer the named tool if your tool list has it; ' +
        'use lanes_tools_call if it does not — which is the case when this endpoint ' +
        'gained a connection after your client last read its tool list.',
    '',
  ];

  for (const match of detailed) {
    // The wire name is the address under `full`. Under `crunched` it names no
    // tool the client can call, so the id — which is what `lanes_tools_call`
    // takes — leads instead.
    lines.push(`## ${surface === 'crunched' ? match.id : match.tool}`);
    const shape = shapeOf(match.entry);
    if (shape.title) lines.push(`${shape.title}`);
    lines.push('');
    lines.push(shape.description.split('\n\nAvailable connections')[0] ?? '');
    lines.push('');
    lines.push(`capability: ${match.id}`);
    lines.push(`reachable:  ${whereReachable(match.entry)}`);
    lines.push('');
    lines.push('arguments (JSON Schema — `profile` and `connection` are added by this endpoint):');
    lines.push('```json');
    lines.push(JSON.stringify(shape.inputSchema, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (listed.length > 0) {
    lines.push(`## ${listed.length} more, without schemas`);
    lines.push('');
    lines.push('Search again with a capability id for one of these to get its arguments.');
    lines.push('');
    for (const match of listed) {
      const shape = shapeOf(match.entry);
      const summary = (shape.description.split('\n')[0] ?? '').slice(0, 100);
      lines.push(`- \`${match.id}\` — ${summary}`);
    }
    lines.push('');
  }

  const hidden = matches.length - detailed.length - listed.length;
  if (hidden > 0) {
    lines.push(`${hidden} further match${hidden === 1 ? '' : 'es'} not shown. Narrow the query.`);
  }

  return lines.join('\n');
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
): string {
  return renderMatches(query, rank(query, merged), surface);
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
