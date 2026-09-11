import { isTool } from '#connectivity';
import { z } from 'zod';
import { sanitizeSchema } from './schema.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * Turning text into words, and words into matches.
 *
 * The primitives the search is built out of, in one place because three files
 * need them and none of them owns them: reading a query, scoring a capability,
 * and rendering an answer all have to agree on what a word is and on when two
 * words are the same word. A second opinion on either would be a bug nobody
 * could see — the ranking would rank things the renderer describes differently,
 * or the match test would disagree with the search it guards.
 */

/**
 * A word, for matching.
 *
 * Split on everything that separates one in an identifier — `.`, `_`, `-`, and
 * a camelCase boundary — because the terms a caller searches for are words and
 * the text being searched is mostly identifiers. Without the camelCase split,
 * `copyTo` never matches *copy*.
 */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}
/**
 * Whether a term is in a word list, allowing for one being a prefix of the other.
 *
 * The cheapest thing that stands in for stemming, and it is needed: a caller
 * types "meetings" and the manifest says "meeting", so exact equality found
 * nothing and the query landed on whatever else shared a word with it. Prefixes
 * cover the endings that actually come up — plurals, `-ing`, `-ed`, `-s` — in
 * both directions, since the query may be the longer or the shorter form.
 *
 * Four characters before a prefix counts, because three would make `get` match
 * `getting` and also `getaway`, and one would make every term match everything.
 * Equality is always enough, so short terms still work as themselves.
 */
export function exactly(list: readonly string[], term: string): boolean {
  return list.includes(term);
}

export function holds(list: readonly string[], term: string): boolean {
  const stem = elide(term);
  return list.some(
    (word) =>
      word === term ||
      (term.length >= 4 && word.startsWith(term)) ||
      (word.length >= 4 && term.startsWith(word)) ||
      (stem !== undefined && (word.startsWith(stem) || elide(word)?.startsWith(stem) === true)),
  );
}
/**
 * A word with its silent trailing `e` removed, where that is safe.
 *
 * English drops it before `-ing` and `-ed`, which prefix matching alone cannot
 * follow: *archiving* does not start with *archive*, so a caller asking to
 * "archive a message" missed the operation whose description explains that
 * archiving is what it does — the one place that fact is written down.
 *
 * Five characters before the `e` comes off, which is what keeps it safe. At four
 * *file* would become *fil* and match *filter* and *filling*; at five *archive*,
 * *delete*, *create* and *schedule* all reach their own participles and nothing
 * else's.
 */
export function elide(word: string): string | undefined {
  return word.length >= 6 && word.endsWith('e') ? word.slice(0, -1) : undefined;
}
/** A synthesised title, as its vendor half and its operation half. */
export function split(title: string): [string, string] {
  const at = title.indexOf(': ');
  return at === -1 ? ['', title] : [title.slice(0, at), title.slice(at + 2)];
}
/** What one capability's title and description are, whichever kind it is. */
export function summaryOf(entry: MergedCapability): { title: string | undefined; description: string } {
  if (entry.discovered) {
    return { title: entry.discovered.title, description: entry.discovered.description };
  }

  const capability = entry.capability;
  if (!capability || !isTool(capability)) return { title: undefined, description: '' };

  return { title: capability.title, description: capability.description };
}
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

/** Whether the search considers this entry at all. */
export function searchable(entry: MergedCapability): boolean {
  return entry.discovered !== undefined || (!!entry.capability && isTool(entry.capability));
}

/**
 * How well one entry answers the query — the whole of the ranking.
 *
 * Its own function because two callers have to agree exactly: the search, and
 * the check in front of it that decides whether a miss is worth re-reading the
 * config for. A second reading of "does this match" would make the endpoint
 * reload for queries that then succeed anyway, and skip the reload for the ones
 * that needed it — both silent.
 *
 * Reaches `shapeOf`, which converts Zod to JSON Schema for every authored
 * capability it is handed. That was worth avoiding while this ran once per term
 * per entry per pass; the memo below is what makes it affordable, so the two
 * changes belong together and the schema field cannot be kept without it.
 */
export function fieldsOf(id: string, entry: MergedCapability): Fields {
  const seen = memo.get(entry);
  if (seen !== undefined && seen.id === id) return seen.fields;

  const fields = computeFields(id, entry);
  memo.set(entry, { id, fields });
  return fields;
}

/**
 * The words in a capability's own arguments.
 *
 * Every other field is what a vendor wrote *about* an operation, and that is
 * routinely thinner than what the operation takes. "send email with attachment"
 * reached nothing: `attachments` is the name of an argument, and no summary of a
 * send operation mentions one. The schema is the only place some of a
 * capability's vocabulary is written down at all.
 *
 * Top-level properties and their own descriptions, and no deeper. A nested
 * schema is mostly the vendor's structure rather than words a caller would
 * search for, and flattening one puts hundreds of terms behind a single
 * capability. `profile` and `connection` are added by this endpoint after this
 * has run, so neither is here to match every query against everything.
 */
function parameterWords(entry: MergedCapability): string[] {
  const properties = shapeOf(entry).inputSchema['properties'];
  if (properties === null || typeof properties !== 'object') return [];

  const found: string[] = [];
  for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
    found.push(...words(name));
    if (property === null || typeof property !== 'object') continue;
    const described = (property as { description?: unknown }).description;
    if (typeof described === 'string') found.push(...words(described));
  }

  return found;
}

/**
 * The same fields, tokenised once per entry instead of once per question asked
 * of it.
 *
 * `scoreEntry` runs over every entry to find the candidates, `inverseFrequency`
 * runs it again once per candidate per term, and the whole ranking runs twice
 * where a search answers in prose and in structured form. Nothing between those
 * passes changes the four strings being split, so they were split tens of times
 * apiece for one query.
 *
 * Keyed on the entry and not the id, because a `MergedCapability` is rebuilt
 * when the generation is, which is the moment the text behind it can change: the
 * map empties itself and there is no expiry to get wrong. The id is kept beside
 * the fields and checked anyway, so a caller that ever pairs an entry with a
 * different id gets the right answer rather than a stale one. `validate.ts`
 * caches compiled validators against the same key for the same reason.
 */
const memo = new WeakMap<MergedCapability, { id: string; fields: Fields }>();

function computeFields(id: string, entry: MergedCapability): Fields {
  const summary = summaryOf(entry);
  const [vendor, ...rest] = id.split('.');
  // `titleFor` renders "<Provider>: <operation>", so the vendor's display name
  // rides in the title of every one of its capabilities — the same free boost
  // the id gave it, one field along. Score the operation half at title weight
  // and let the vendor half fall in with the provider id, where it belongs.
  const [prefix, operation] = split(summary.title ?? '');

  return {
    name: rest.length > 0 ? rest.flatMap((segment) => words(segment)) : words(id),
    title: words(operation),
    provider: [...words(vendor ?? ''), ...words(prefix)],
    // The connections block `describeWithConnections` appends is not part of
    // what this searches — it is identical on every tool, so it would match
    // every term in it against everything.
    description: words(summary.description.split('\n\nAvailable connections')[0] ?? ''),
    parameters: parameterWords(entry),
  };
}
export type Fields = {
  readonly name: string[];
  readonly title: string[];
  readonly provider: string[];
  readonly description: string[];
  readonly parameters: string[];
};
export function scoreEntry(id: string, entry: MergedCapability, terms: readonly string[]): number {
  const { name, title, provider, description, parameters } = fieldsOf(id, entry);

  let score = 0;
  for (const term of terms) {
    // The operation's own name is worth most. The *vendor's* name is scored
    // separately and lower, and that separation is load-bearing rather than
    // tidiness: scored together, a provider whose id happens to contain a domain
    // word wins every query in that domain on spelling alone. `outlook_mail`
    // beat `gmail` on "latest email in inbox" for exactly that reason — `mail`
    // is in its id and not in Gmail's — and no query had named either vendor.
    // A vendor's name is which account, not what the operation does.
    if (holds(name, term)) score += 3;
    else if (holds(title, term)) score += 2;
    else if (holds(provider, term)) score += 1.5;
    else if (holds(description, term)) score += 1;
    // Last, and worth half of prose. An argument name is evidence that a
    // capability *deals in* the thing asked for, which is weaker than a vendor
    // writing that it does: every mail operation takes an `id`, and a schema is
    // machine vocabulary that was never chosen to describe anything.
    else if (holds(parameters, term)) score += 0.5;
  }

  return score;
}
