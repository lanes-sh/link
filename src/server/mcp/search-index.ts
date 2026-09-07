import { isTool } from '#connectivity';
import { z } from 'zod';
import { toolNameFor } from './naming.ts';
import { sanitizeSchema } from './schema.ts';
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

/**
 * A word, for matching.
 *
 * Split on everything that separates one in an identifier — `.`, `_`, `-`, and
 * a camelCase boundary — because the terms a caller searches for are words and
 * the text being searched is mostly identifiers. Without the camelCase split,
 * `copyTo` never matches *copy*.
 */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** What one capability's title, description and schema are, whichever kind it is. */
function shapeOf(entry: MergedCapability): {
  title: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  if (entry.discovered) {
    return {
      title: entry.discovered.title,
      description: entry.discovered.description,
      inputSchema: sanitizeSchema(entry.discovered.inputSchema),
    };
  }

  const capability = entry.capability;
  if (!capability || !isTool(capability)) {
    return { title: undefined, description: '', inputSchema: { type: 'object' } };
  }

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

  return { title: capability.title, description: capability.description, inputSchema };
}

interface Match {
  readonly id: string;
  readonly tool: string;
  readonly score: number;
  readonly entry: MergedCapability;
}

/**
 * Rank the reachable capabilities against a query.
 *
 * Deliberately simple, and the reason is worth stating: a client that defers
 * tool loading already runs BM25 or a regex over the same names and
 * descriptions, locally, with no round trip. This is the fallback for clients
 * that do not, so it needs to be good enough to find the right provider rather
 * than good enough to replace an index. Term presence, weighted by where it
 * appears, and no tie-breaking beyond that.
 *
 * An exact capability id short-circuits, because "give me the schema for
 * `gmail.send_message`" is the second call a model makes after a search and it
 * should not be a search.
 */
function rank(query: string, merged: Map<string, MergedCapability>): Match[] {
  const exact = merged.get(query.trim());
  if (exact) {
    return [{ id: query.trim(), tool: toolNameFor(query.trim()), score: 1, entry: exact }];
  }

  const terms = words(query);
  if (terms.length === 0) return [];

  const matches: Match[] = [];

  for (const [id, entry] of merged) {
    if (!entry.discovered && !(entry.capability && isTool(entry.capability))) continue;

    const shape = shapeOf(entry);
    const name = words(id);
    const title = words(shape.title ?? '');
    // The connections block `describeWithConnections` appends is not part of
    // what this searches — it is identical on every tool, so it would match
    // every term in it against everything.
    const description = words(shape.description.split('\n\nAvailable connections')[0] ?? '');

    let score = 0;
    for (const term of terms) {
      // The name is worth most: it carries the provider id, which is how a
      // query naming a vendor finds that vendor's tools at all.
      if (name.includes(term)) score += 3;
      else if (name.some((word) => word.startsWith(term))) score += 2;
      else if (title.includes(term)) score += 2;
      else if (description.includes(term)) score += 1;
    }

    if (score > 0) matches.push({ id, tool: toolNameFor(id), score, entry });
  }

  // Score first, then id, so the order is stable across calls — the same
  // property `tools/list` is asked for, and for the same reason: a caller
  // comparing two searches should be comparing results, not orderings.
  return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Where a capability can be used, as the search reports it. */
function whereReachable(entry: MergedCapability): string {
  return [...entry.reachable]
    .map(([profile, connections]) => `${profile}: ${connections.join(', ')}`)
    .join(' | ');
}

function renderMatches(query: string, matches: readonly Match[]): string {
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
    'Each one is invocable two ways. Prefer the named tool if your tool list has it; ' +
      'use lanes_tools_call if it does not — which is the case when this endpoint ' +
      'gained a connection after your client last read its tool list.',
    '',
  ];

  for (const match of detailed) {
    lines.push(`## ${match.tool}`);
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
export function searchCapabilities(query: string, merged: Map<string, MergedCapability>): string {
  return renderMatches(query, rank(query, merged));
}
