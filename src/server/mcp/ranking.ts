import { isTool } from '#connectivity';
import type { MergedCapability } from './visibility.ts';
import { toolNameFor } from './naming.ts';
import { fieldsOf, holds, scoreEntry, searchable, words } from './searchable.ts';
import {
  actionOf,
  READ_VERBS,
  WRITE_VERBS,
  DESTRUCTIVE_VERBS,
  type Intent,
  intentOf,
  namesOne,
  plural,
  queryTerms,
  queryWords,
  confidence,
  shapeOf_,
} from './query.ts';

/**
 * How well a capability answers a question, and nothing about how it is shown.
 *
 * Split out of `search-index.ts` when the ranking stopped being a scoring loop
 * and became a subject: what a word is worth depends on how many capabilities
 * share it, what the caller is asking to *do*, whether they want one thing or
 * several, and which of a provider's nouns it is actually about. That is four
 * arguments and a table of domain vocabulary, and none of it has anything to
 * say about rendering.
 *
 * The rule that survives the split unchanged: **whether something matches is
 * `scoreEntry(...) > 0` and only that.** `matchesQuery` shares it with the
 * search so the endpoint cannot reload for queries that would have succeeded,
 * and everything else here decides order among entries that already matched.
 */
























/**
 * The thing a provider is mostly about, taken from how often it talks about it.
 *
 * Gmail has capabilities under `messages`, `drafts`, `labels` and `threads`, and
 * a bare "email" matches all four identically because the provider's keywords
 * are appended to all four identically. Something has to break that tie, and the
 * honest signal already present is proportion: an API devotes more operations to
 * its subject than to its accessories. Four `messages.*` against one `labels.*`
 * is the vendor saying which one is the point.
 *
 * Derived rather than declared, so it costs no per-provider authoring and cannot
 * drift from the surface it describes. It is a tiebreak and weighted like one:
 * it must not outrank a term that genuinely matched.
 */
function primaryResources(merged: Map<string, MergedCapability>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();

  for (const [id, entry] of merged) {
    if (!searchable(entry)) continue;
    const [provider, ...rest] = id.split('.');
    if (provider === undefined || rest.length === 0) continue;
    const resource = resourceOf(rest);
    if (resource === undefined) continue;

    const byResource = counts.get(provider) ?? new Map<string, number>();
    byResource.set(resource, (byResource.get(resource) ?? 0) + 1);
    counts.set(provider, byResource);
  }

  const primary = new Map<string, string>();
  for (const [provider, byResource] of counts) {
    const best = [...byResource].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && best[1] > 1) primary.set(provider, best[0]);
  }
  return primary;
}

/** The noun in a capability name, once its verbs and its scoping words are gone. */
function resourceOf(segments: readonly string[]): string | undefined {
  const nouns = segments
    .flatMap((segment) => words(segment))
    .filter((word) => !READ_VERBS.has(word) && !WRITE_VERBS.has(word) && word !== 'users' && word !== 'me');
  return nouns[nouns.length - 1];
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
/**
 * How much each term narrows the field — IDF, and the fix for the whole failure.
 *
 * `withKeywords` appends a provider's vocabulary to every one of its
 * capabilities, identically. That is what makes Gmail findable at all, and it is
 * also why "latest email in inbox" scored all eight Gmail tools the same: `email`
 * and `inbox` matched the tail on every one of them, so the only thing left to
 * separate them was `localeCompare`, and `drafts` sorts before `messages`.
 *
 * A term matching every candidate carries no information about which candidate
 * to pick. That is Spärck Jones' 1972 observation and it is what every ranking
 * function since has been built on. Weighting by it means the shared tail still
 * finds the provider — it just stops deciding *which* of that provider's tools
 * wins, which was never something it could know.
 *
 * Floored rather than decayed to nothing: a word every candidate shares is
 * uninformative, not wrong, and zeroing it would let one incidental match on a
 * rare word outrank a tool that matched the whole query.
 */
function inverseFrequency(
  terms: readonly string[],
  candidates: readonly { id: string; entry: MergedCapability }[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const total = candidates.length || 1;

  for (const term of terms) {
    let seen = 0;
    for (const { id, entry } of candidates) if (scoreEntry(id, entry, [term]) > 0) seen++;
    weights.set(term, Math.max(0.15, Math.log(1 + total / Math.max(seen, 1)) / Math.log(1 + total)));
  }
  return weights;
}

/**
 * The ordering score: the same fields, weighted by what each term is worth.
 *
 * Two things differ from `scoreEntry`, and both are deliberate. Whether an entry
 * matches at all is still that function's answer and only that function's — this
 * one runs over entries already known to match, so it cannot promote a miss.
 *
 * The restriction is the second: **an inferred term matches descriptions only.**
 * A synonym is a claim about a domain's vocabulary, and a domain's vocabulary is
 * what descriptions carry — `withKeywords` puts it there on purpose. Names are
 * the vendor's own precise identifiers, and letting an inferred word match one
 * is where every wrong answer came from: expanding "email" reached `sendMail`
 * and `outlook_mail` by their spelling, so a query asking to *read* the newest
 * mail ranked the tool that *sends* it, twice over.
 */
function weighted(
  id: string,
  entry: MergedCapability,
  terms: readonly string[],
  specificity: Map<string, number>,
  typed: Map<string, number>,
): number {
  const fields = fieldsOf(id, entry);
  const typedTerms = terms.filter((term) => (typed.get(term) ?? 1) === 1).length;
  let score = 0;
  let matched = 0;

  for (const term of terms) {
    const confidence = typed.get(term) ?? 1;
    const inferred = confidence < 1;
    const hit = inferred
      ? holds(fields.description, term)
        ? 1
        : 0
      : holds(fields.name, term)
        ? 3
        : holds(fields.title, term)
          ? 2
          : holds(fields.provider, term)
            ? 1.5
            : holds(fields.description, term)
              ? 1
              : 0;

    score += hit * (specificity.get(term) ?? 1) * confidence;
    if (hit > 0 && !inferred) matched++;
  }

  // How much of what they asked for this actually answers.
  //
  // A rare word matching one field beats several common words matching several,
  // and that is usually right — except when the rare word is a modifier and the
  // common ones are the subject. "latest email in inbox" put
  // `github.get_latest_release` first because *latest* is rare and sits in its
  // name, while *email* and *inbox* are common and sit in every mail tool's
  // description. One term out of three, and the two it missed were what the
  // question was about.
  //
  // Soft, not a filter. Requiring every term was tried and is brittle: one typo,
  // one product name, one "please", and nothing matches at all. Scaling by the
  // fraction covered keeps a partial match in the running and puts the tool that
  // answers more of the question above it.
  const coverage = typedTerms === 0 ? 1 : matched / typedTerms;
  return score * (0.4 + 0.6 * coverage);
}

/**
 * The two tiebreaks, worth less than any real term match.
 *
 * Deliberately small. Both are guesses about what a caller probably meant, and a
 * guess must never displace a word they actually typed — so the largest either
 * can contribute is under the weight of one description hit.
 */
/**
 * The tiebreaks, as a multiplier rather than an addition.
 *
 * Additive bonuses were wrong in a way a large fixture hides and a small one
 * exposes at once: they are absolute, while the term scores they sit beside
 * scale with specificity and coverage. On a four-tool surface the scores are
 * small, so a fixed +0.85 for "reads, and enumerates" lifted a tool that had
 * matched *one* word of a two-word query above the tool that matched both — and
 * `vendor_chat` started returning `vendor_mail`'s tools.
 *
 * A tiebreak that can do that is not a tiebreak. As a multiplier it can only
 * reorder entries whose term scores were already close, which is the entire job.
 */
function fit(
  id: string,
  primary: Map<string, string>,
  intent: Intent,
  wantsMany: boolean,
  asked: boolean,
): number {
  const [provider, ...rest] = id.split('.');
  if (provider === undefined || rest.length === 0) return 1;

  const name = rest.flatMap((segment) => words(segment));
  let bonus = 0;

  const subject = primary.get(provider);
  const resource = resourceOf(rest);
  if (subject !== undefined && resource !== undefined && holds([resource], subject)) bonus += 0.4;

  const action = actionOf(name);
  if (action === intent.wants) bonus += intent.explicit ? 0.35 : 0.15;
  else if (action !== undefined && intent.explicit) bonus -= 0.35;

  if (wantsMany) {
    const kind = shapeOf_(name);
    if (kind === 'enumerate') bonus += 0.5;
    else if (kind === 'fetch') bonus -= 0.5;
  }

  // Destroying something is never the charitable reading of an ambiguous ask.
  //
  // "schedule an appointment" is a write, and so are `events.insert` and
  // `events.delete`; with nothing else to separate them the tie fell to
  // `localeCompare`, which answers *delete*. Ranking is not authorisation and a
  // wrong first result costs only a wasted turn — but the wasted turn is a
  // deletion the caller has to decline, and offering it is a worse failure than
  // offering nothing. A caller who wants something gone says so.
  if (!asked) {
    const name_ = name;
    if (name_.some((word) => DESTRUCTIVE_VERBS.has(word))) bonus -= 0.6;
  }

  return 1 + bonus;
}

/** One capability, with how well it answered and enough to render it. */
/**
 * Whether a capability only reads, as its own name says.
 *
 * The same reading `fit` uses to order results, exposed so a caller can ask for
 * it outright. `readOnly: true` is a filter on the answer and never a claim
 * about authority: policy decides what may be called, and a hint about
 * behaviour cannot grant or withhold anything.
 */
export function reads(id: string): boolean {
  const rest = id.split('.').slice(1);
  return actionOf(rest.flatMap((segment) => words(segment))) === 'read';
}

export interface Match {
  readonly id: string;
  readonly tool: string;
  readonly score: number;
  readonly entry: MergedCapability;
}

export function rank(query: string, merged: Map<string, MergedCapability>): Match[] {
  const exact = merged.get(query.trim());
  if (exact) {
    return [{ id: query.trim(), tool: toolNameFor(query.trim()), score: 1, entry: exact }];
  }

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const candidates: { id: string; entry: MergedCapability; base: number }[] = [];
  for (const [id, entry] of merged) {
    if (!searchable(entry)) continue;

    const base = scoreEntry(id, entry, terms);
    if (base > 0) candidates.push({ id, entry, base });
  }

  // Ordering signals, applied here and never inside `scoreEntry`.
  //
  // `matchesQuery` shares `scoreEntry` with this function, and commit 6a18908's
  // predecessor exists because two readings of "does this match" drifted. So
  // whether something matches is still `scoreEntry(...) > 0` exactly; what
  // follows only decides the order among things that already matched, and
  // cannot make a miss into a hit or the reverse.
  const specificity = inverseFrequency(terms, candidates);
  const typed = confidence(queryWords(query));
  const primary = primaryResources(merged);
  const intent = intentOf(queryWords(query));
  const wantsMany =
    intent.wants === 'read' && (intent.explicit || plural(queryWords(query))) && !namesOne(terms);
  const asked = queryWords(query).some((word) => DESTRUCTIVE_VERBS.has(word));

  const matches: Match[] = candidates.map(({ id, entry }) => ({
    id,
    tool: toolNameFor(id),
    score:
      weighted(id, entry, terms, specificity, typed) *
      fit(id, primary, intent, wantsMany, asked),
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
  // Two narrower rules were tried and both were worse, which is why the cut is
  // on the score rather than on how much of the query matched:
  //
  //   - *Every term* is brittle. One word the surface does not contain — a typo,
  //     a product name, "please" — and nothing matches all of them, so the query
  //     falls back to the loose ranking it was meant to replace.
  //   - *The most terms* inverts the weighting. "please send a message to
  //     someone" picked a mail-filter tool over the one that sends, because
  //     `someone` happened to appear in its description and three weak
  //     description hits outrank two strong ones.
  //
  // The score already carries both halves — more of the query matched is more
  // points, and the name is worth three times the description — so cutting
  // relative to the best score keeps a tool named for what was asked and drops
  // one that merely mentions it. Half is a ratio rather than a threshold
  // because scores scale with query length, and it leaves a genuine second
  // candidate in: two strong hits survive beside three.
  // Strictly more than half, not at least: on a two-term query naming a
  // provider, a tool matching only the provider half scores exactly half of
  // one matching both, and "every other tool this provider has" is not an
  // answer to a query that named a capability too.
  const best = matches[0]?.score ?? 0;
  return matches.filter((match) => match.score * 2 > best);
}
