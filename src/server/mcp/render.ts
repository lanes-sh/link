import type { Match } from './ranking.ts';
import { schemaFor, shapeOf } from './search-index.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * Turning a ranking into something a caller can act on in one turn.
 *
 * Its own file because deciding *what* answers and deciding *how much of it to
 * say* are different problems, and the second one grew: how many to explain, in
 * what order across accounts, within what budget, and what to put around them so
 * the answer stands without a second question.
 */

/** How many matches an answer explains when the caller does not say. */
export const DEFAULT = 3;

/**
 * What an answer may cost, in bytes of the caller's context.
 *
 * A count was the wrong unit. Three matches is 900 bytes of one provider's
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

/** How close to the best a provider must be to count as a second opinion. */
const CONTENDER = 0.15;

/**
 * The accounts a caller can reach, by profile — the box at the top of an answer.
 *
 * Every routing argument this endpoint takes is a profile and a connection, and
 * a caller who has just been handed a capability id still has to discover both
 * before it can use it. That discovery was its own round trip: on the exchange
 * this work began with, `lanes_setup_overview` was the second of seven calls,
 * asked before the search that found anything.
 *
 * It is a short, fixed list and the search already knows it. Putting it at the
 * top of every answer means one call returns what to do, where to do it, and as
 * whom.
 */
export type Accounts = ReadonlyMap<string, ReadonlyMap<string, string>>;

function context(accounts: Accounts | undefined): string[] {
  if (accounts === undefined || accounts.size === 0) return [];

  const lines = ['Reachable from here — pass one of these as `profile` and `connection`:'];
  for (const [profile, connections] of accounts) {
    if (connections.size === 0) continue;
    lines.push(`  ${profile}`);
    for (const [ref, account] of connections) lines.push(`    ${ref} — ${account}`);
  }

  return lines.length > 1 ? [...lines, ''] : [];
}

/** Where a capability can be used, as the search reports it. */
function whereReachable(entry: MergedCapability): string {
  return [...entry.reachable]
    .map(([profile, connections]) => `${profile}: ${connections.join(', ')}`)
    .join(' | ');
}

export function renderMatches(
  query: string,
  matches: readonly Match[],
  surface: 'full' | 'crunched' | undefined,
  limit: number,
  accounts?: Accounts,
): string {
  if (matches.length === 0) {
    return (
      `${context(accounts).join('\n')}Nothing reachable matches "${query}".\n\n` +
      'This searched every capability this caller can reach, so a miss means it is ' +
      'not connected or not granted rather than not spelled right. ' +
      'Call lanes_setup_overview for what is connected and what connecting something else takes.'
    );
  }

  const { detailed, omitted } = afford(matches, limit);

  const lines: string[] = [
    ...context(accounts),
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

  // What is left is *counted*, never listed.
  //
  // The list used to run to twenty ids with no schemas under the line "Search
  // again with a capability id for one of these to get its arguments" — which
  // is an instruction to spend another round trip, printed twenty times. On the
  // endpoint this work started from it was reached on the query that mattered:
  // the capability that reads a mailbox was in that tail, so answering "what is
  // the last email" cost two searches before the first call.
  //
  // Everything above is complete enough to invoke. Anything below it is a
  // narrower query away, and saying so once is enough.
  if (omitted > 0) {
    lines.push(
      `${omitted} further match${omitted === 1 ? '' : 'es'} scored lower and are not shown. ` +
        'Narrow the query, or raise `limit`, if none of the above is what you meant.',
    );
  }

  return lines.join('\n');
}

/**
 * The best of each account first, then depth.
 *
 * Which of two connected mail accounts a caller meant is not something this
 * endpoint can know, and the answer it *can* give is both of them with their
 * accounts named. Ranked purely by score it gave neither: three operations of
 * the better-worded provider filled every slot, and the second account never
 * appeared — so a question about mail was answered as though one mailbox
 * existed.
 *
 * Breadth before depth, then, but only among providers that plausibly answer.
 * Without that floor breadth promoted whatever else had scraped a match, and a
 * release-notes tool took the second slot on a mail query — the failure this
 * whole branch began with, arriving by way of the fix for a different one.
 */
function order(matches: readonly Match[]): Match[] {
  const best = matches[0]?.score ?? 0;
  const seen = new Set<string>();
  const first: Match[] = [];
  const rest: Match[] = [];

  for (const match of matches) {
    const provider = match.id.split('.')[0] ?? match.id;
    if (match.score < best * CONTENDER || seen.has(provider)) rest.push(match);
    else {
      seen.add(provider);
      first.push(match);
    }
  }

  return [...first, ...rest];
}

/**
 * How many matches this answer can afford to explain properly.
 *
 * Spends the budget on whole entries rather than trimming every entry to fit:
 * a schema with its properties removed does not cost less, it costs the same
 * and buys nothing, because the caller still cannot compose the call. Better
 * three capabilities the caller can invoke than eight they must ask about.
 */
export function afford(
  matches: readonly Match[],
  limit: number,
): { detailed: Match[]; omitted: number } {
  const ceiling = Math.max(FEWEST, Math.min(limit, MOST));
  const detailed: Match[] = [];
  let spent = 0;

  for (const match of order(matches)) {
    if (detailed.length >= ceiling) break;
    const cost = JSON.stringify(shapeOf(match.entry).inputSchema).length;
    if (detailed.length >= FEWEST && spent + cost > BUDGET) break;
    detailed.push(match);
    spent += cost;
  }

  return { detailed, omitted: matches.length - detailed.length };
}
