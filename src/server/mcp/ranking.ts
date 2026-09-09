import { isTool } from '#connectivity';
import { toolNameFor } from './naming.ts';
import type { MergedCapability } from './visibility.ts';
import { holds, namesOne, providerNamed, providerOf, queryTerms, words } from './terms.ts';
import { buildIndex, embedQuery, nearness, type VectorIndex } from './vector/index.ts';

/**
 * How well a capability answers a question, and nothing about how it is shown.
 *
 * Split out of `search-index.ts` when the ranking stopped being one scoring
 * loop: it now reads a capability three ways — the words in it, the meaning of
 * the text around it, and the arguments it insists on — and none of the three
 * has anything to say about rendering. The file-size budget in
 * `architecture.test.ts` is what forced the question, and the seam it found is
 * the one that was already there.
 *
 * The rule that survives the split unchanged: **`matchesQuery` and `rank` agree
 * on what a candidate is.** They share this file so they cannot drift, because
 * a disagreement would make the endpoint re-read its config for queries that
 * would have succeeded, and skip the re-read for the ones that needed it — both
 * silent.
 */

/** What one capability's title and description are, whichever kind it is. */
export function summaryOf(entry: MergedCapability): { title: string | undefined; description: string } {
  if (entry.discovered) {
    return { title: entry.discovered.title, description: entry.discovered.description };
  }

  const capability = entry.capability;
  if (!capability || !isTool(capability)) return { title: undefined, description: '' };

  return { title: capability.title, description: capability.description };
}

/** Whether the search considers this entry at all. */
function searchable(entry: MergedCapability): boolean {
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
 * Deliberately reads `summaryOf` rather than `shapeOf`: nothing here looks at a
 * schema, and `shapeOf` converts Zod to JSON Schema for every authored
 * capability it is handed.
 */
function scoreEntry(id: string, entry: MergedCapability, terms: readonly string[]): number {
  const summary = summaryOf(entry);
  const name = words(id);
  const title = words(summary.title ?? '');
  // The connections block `describeWithConnections` appends is not part of
  // what this searches — it is identical on every tool, so it would match
  // every term in it against everything.
  const description = words(summary.description.split('\n\nAvailable connections')[0] ?? '');

  let score = 0;
  for (const term of terms) {
    // The name is worth most: it carries the provider id, which is how a
    // query naming a vendor finds that vendor's tools at all.
    if (holds(name, term)) score += 3;
    else if (holds(title, term)) score += 2;
    else if (holds(description, term)) score += 1;
  }

  return score;
}

export interface Match {
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
export function rank(query: string, merged: Map<string, MergedCapability>): Match[] {
  const exact = merged.get(query.trim());
  if (exact) {
    return [{ id: query.trim(), tool: toolNameFor(query.trim()), score: 1, entry: exact }];
  }

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  // A query that is exactly a provider's name is a lookup, not a question.
  //
  // The same reasoning as the exact-capability-id short-circuit above, one
  // level up: "vendor_chat" and "notion" name a thing this endpoint holds, and
  // the answer is that thing's capabilities rather than the capabilities that
  // resemble its name. Without this the semantic half is right to widen —
  // a chat provider's tools genuinely do resemble a mail provider's — and the
  // caller who named one vendor gets another vendor's tools mixed in.
  //
  // Narrow rather than boost, because a partial answer here is the wrong shape:
  // a caller asking what a provider offers wants its list, not its list with
  // three neighbours interleaved.
  const named = providerNamed(terms, merged);

  const index = indexFor(merged);
  // Embedded from the terms rather than from the sentence, so the two halves of
  // the ranking read the same query. `search-index.test.ts` asserts that "send
  // message" and "please send a message to me" return the same set, and it is
  // the right assertion: the words a caller wraps a request in are grammar, and
  // a search that answers them differently is answering their phrasing.
  //
  // Safe for this kind of model in a way it would not be for a transformer: a
  // static embedding is a weighted mean over tokens with no notion of order, so
  // there is no syntax for the stripping to destroy.
  const asked = index ? embedQuery(terms.join(' '), index) : undefined;
  const holdsOne = namesOne(query);

  const scored: { id: string; entry: MergedCapability; lexical: number; dense: number }[] = [];
  let bestLexical = 0;
  let bestDense = 0;

  for (const [id, entry] of merged) {
    if (!searchable(entry)) continue;
    if (named !== undefined && providerOf(id) !== named) continue;

    const lexical = scoreEntry(id, entry, terms);
    const vectors = asked && index ? index.entries.get(id) : undefined;
    const dense = asked && vectors ? nearness(asked, vectors) : 0;

    // A candidate is anything the words found, or anything near enough in
    // meaning to be worth ranking. The second half is the point of the index:
    // "latest email in inbox" shares no word with `users.messages.list`, so a
    // set built from term presence alone cannot contain the answer however
    // well it is then ordered.
    if (lexical === 0 && dense < NEAR) continue;

    if (lexical > bestLexical) bestLexical = lexical;
    if (dense > bestDense) bestDense = dense;
    scored.push({ id, entry, lexical, dense });
  }

  const matches: Match[] = scored.map(({ id, entry, lexical, dense }) => ({
    id,
    tool: toolNameFor(id),
    score:
      blend(lexical, bestLexical, dense, bestDense) *
      (holdsOne ? 1 : 1 / (1 + REACH * identifiers(entry))),
    entry,
  }));

  // Score first, then id, so the order is stable across calls — the same
  // property `tools/list` is asked for, and for the same reason: a caller
  // comparing two searches should be comparing results, not orderings.
  matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Everything at least half as good as the best match, and nothing weaker.
  //
  // Measured against a real endpoint serving 276 tools, returning everything
  // that scored at all made the search look useless while behaving correctly:
  // "create a pull request" reported 213 matches, because `create` and
  // `request` each appear all over a large surface. The top of the ranking was
  // right every time — the count and the tail were the lie, and the tail is
  // twenty tools of noise in the caller's context.
  //
  // The cut is on the blended score for the same reason it was on the lexical
  // one: it is a ratio rather than a threshold, so it does not have to know
  // what a good score looks like for this query.
  const best = matches[0]?.score ?? 0;
  return matches.filter((match) => match.score * 2 > best);
}

/**
 * The two scores as one, each read relative to the best of its own kind.
 *
 * Relative rather than absolute on both sides, and that is the load-bearing
 * choice. The lexical score scales with how many terms a query has; a cosine
 * between two short English texts sits in a narrow band well above zero, so an
 * unrelated capability scores 0.3 and a perfect one 0.8. Added raw, the cosine
 * band would swamp the lexical signal on short queries and vanish under it on
 * long ones. Divided by the best of its own kind, each says the same thing —
 * *how close to the best answer of this sort is this* — and the weights below
 * are then a statement about which sort to trust, which is the only thing they
 * should be.
 *
 * The lexical half is trusted more, because when it fires it is usually right:
 * a caller who typed the operation's own word meant that operation. The dense
 * half decides among the many capabilities that lexical scoring cannot
 * separate at all — which, on a crowded surface, is most of them.
 */
/**
 * How many arguments a capability insists on that the caller would have to
 * already know.
 *
 * The distinction no amount of ranking on text can draw, and the one the
 * question that started this turns on: `messages.get` and `messages.list` are
 * both reads, describe themselves almost identically, and share every keyword
 * their provider declares. Nothing in either text says which one can answer
 * "the latest email" — but their schemas do. `get` requires a message id, and
 * a caller who had one would not be asking.
 *
 * Read off the schema rather than off the operation's name, which is what makes
 * it a fact rather than a convention. A verb table has to be told that `get`
 * fetches and `list` enumerates and then told again for `retrieve`, `fetchOne`,
 * `read`, and whatever the next vendor calls it; a required `fileId` is the
 * same fact in every naming convention, including the ones nobody has invented
 * yet.
 *
 * Counted rather than tested, because a scope is an identifier too. Listing a
 * calendar's events requires a `calendarId`, so "requires an id at all" separates
 * nothing — what separates them is that fetching one event requires *two*.
 */
function identifiers(entry: MergedCapability): number {
  const schema = entry.discovered?.inputSchema as { required?: unknown } | undefined;
  const required = Array.isArray(schema?.required) ? (schema.required as unknown[]) : [];
  return required.filter((name) => typeof name === 'string' && IDENTIFIER.test(name)).length;
}

/** What an argument is called when it names one particular thing. */
const IDENTIFIER = /(^|[^a-z])(id|ids|key|name|path|uri|url|article|q)$|id$/i;

function blend(lexical: number, bestLexical: number, dense: number, bestDense: number): number {
  const words = bestLexical > 0 ? lexical / bestLexical : 0;
  const meaning = bestDense > 0 ? Math.max(0, dense) / bestDense : 0;
  return LEXICAL * words + (1 - LEXICAL) * meaning;
}

/** How much of the blend the words decide. */
const LEXICAL = 0.4;

/**
 * How near a capability must be to be ranked on meaning alone.
 *
 * Everything a static embedding is asked about is somewhat near everything
 * else — the floor of the cosine band, not zero. Set below where the answers
 * sit and above where the noise does, so a query whose words miss entirely
 * still has candidates, and a query whose words hit is not joined by the whole
 * catalogue.
 */
const NEAR = 0.35;

/**
 * How much one unsupplied identifier costs.
 *
 * A discount rather than a filter, because requiring an id does not make an
 * operation wrong — the caller may be about to look one up, and a search that
 * hid every such capability would hide the second call of every two-call
 * sequence. Small enough that a capability the words clearly named still wins.
 */
const REACH = 0.1;

/**
 * The index for one generation of the catalogue, built once.
 *
 * Keyed on the merged map itself, which is the object `mergeCapabilities`
 * memoises per revision — so the index has exactly the lifetime of the
 * catalogue it describes and is collected with it. Nothing is written down:
 * the vectors are derived from text the endpoint already holds, and a stored
 * copy would be a second thing to invalidate for no gain over rebuilding it in
 * a few milliseconds.
 */
const INDEXES = new WeakMap<ReadonlyMap<string, MergedCapability>, VectorIndex | undefined>();

function indexFor(merged: ReadonlyMap<string, MergedCapability>): VectorIndex | undefined {
  if (INDEXES.has(merged)) return INDEXES.get(merged);
  const built = buildIndex(merged);
  INDEXES.set(merged, built);
  return built;
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

  const index = indexFor(merged);
  const asked = index ? embedQuery(query, index) : undefined;

  for (const [id, entry] of merged) {
    if (!searchable(entry)) continue;
    if (scoreEntry(id, entry, terms) > 0) return true;

    const vectors = asked && index ? index.entries.get(id) : undefined;
    if (asked && vectors && nearness(asked, vectors) >= NEAR) return true;
  }

  return false;
}
