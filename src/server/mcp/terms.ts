import type { MergedCapability } from './visibility.ts';

/**
 * Reading a query, and deciding when two words are the same word.
 *
 * The primitives the ranking is built out of, in one place because three
 * questions need them and none owns them: what a caller actually searched for,
 * whether a capability's text contains it, and whether the query names a thing
 * this endpoint holds rather than describing one.
 *
 * Split out of `ranking.ts` for the file-size budget, and the seam is real:
 * nothing here has seen a score, and nothing here can be wrong in a way that
 * changes an *order* — only in a way that changes what a word is.
 */

/**
 * Function words, dropped from a *query* and never from the text searched.
 *
 * The narrowing in `rank` requires every term to match, which makes a query's
 * grammar load-bearing: "send an email" asked for `an` as a whole word, matched
 * nothing that also had `send` and `email`, and fell back to the loose ranking
 * it was meant to replace — 93 matches out of 276 on a real endpoint. Removing
 * them is what a BM25 index does implicitly by weighting a term that appears
 * everywhere at nearly nothing; here it has to be explicit, because presence is
 * the test.
 *
 * Function words only. Nothing here can name a capability: `get`, `set`, `list`,
 * `read` and `send` are all verbs a caller means, and `all` is in a real
 * operation id, so none of them belongs on this list however common it is.
 *
 * Only applied where it leaves something behind — a query that is nothing but
 * these keeps them, so "all of it" searches for something rather than for
 * nothing.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', 'it', 'its',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as',
  'of', 'to', 'for', 'from', 'in', 'into', 'on', 'at', 'by', 'with', 'about',
  'is', 'are', 'was', 'be', 'been', 'do', 'does', 'did', 'can', 'could',
  'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'some', 'any', 'each', 'every', 'no', 'not',
  // Question and request framing. A caller types "what meetings do i have",
  // and `what` and `have` are as much grammar as `the` is.
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'have', 'has', 'had', 'please', 'want', 'wants', 'need', 'needs', 'let',
]);

/** The terms a query actually searches on. */
export function queryTerms(query: string): string[] {
  const all = words(query);
  const meaningful = all.filter((word) => !STOPWORDS.has(word));
  return meaningful.length > 0 ? meaningful : all;
}

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
export function holds(list: readonly string[], term: string): boolean {
  return list.some(
    (word) =>
      word === term ||
      (term.length >= 4 && word.startsWith(term)) ||
      (word.length >= 4 && term.startsWith(word)),
  );
}

/** The provider half of a capability id. */
export function providerOf(id: string): string {
  return id.split('.')[0] ?? id;
}

/**
 * The provider a query names outright, if it names one.
 *
 * Matched on the provider's *words* rather than on its spelling, so
 * "google tasks", "google_tasks" and "Google Tasks" are one query. Every word
 * of the provider must be present and the query must add nothing, because
 * "notion pages" is a question about Notion rather than a request for all of
 * it — and answering it with the whole provider would drop the half the caller
 * typed.
 */
export function providerNamed(
  terms: readonly string[],
  merged: ReadonlyMap<string, MergedCapability>,
): string | undefined {
  const asked = new Set(terms);

  for (const id of merged.keys()) {
    const provider = providerOf(id);
    const spelled = words(provider);
    if (spelled.length === 0 || spelled.length !== asked.size) continue;
    if (spelled.every((word) => asked.has(word))) return provider;
  }

  return undefined;
}

/**
 * Whether the caller already holds the thing they are asking about.
 *
 * "Get the schema for this message" supplies one; "the latest email" does not,
 * and the difference decides whether an operation that demands an id is an
 * answer or a dead end. Deliberately narrow: the cost of reading a query as
 * naming one when it does not is putting a fetch above a list, which is the
 * failure this is here to prevent.
 */
export function namesOne(query: string): boolean {
  return /\b(this|that|specific|by id|given|particular)\b/i.test(query) || /[A-Za-z0-9_-]{16,}/.test(query);
}

