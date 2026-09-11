import { holds, words } from './searchable.ts';

/**
 * What the caller asked for, before anything is looked up.
 *
 * A query is not a bag of words. It has a subject, and it may have a verb, and
 * whether the verb is there at all changes what the absence of one means. This
 * file is the whole of that reading: which words to drop, which to infer, what
 * the caller is asking to *do*, and whether they want one of something or
 * several. It knows nothing about capabilities.
 *
 * Separated from the scoring because the two answer different questions and
 * were only ever adjacent. The scoring asks how well a capability matches; this
 * asks what it would mean to match well.
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
export const STOPWORDS = new Set([
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
  return expand(queryWords(query));
}
/** What the caller typed, before anything is inferred from it. */
export function queryWords(query: string): string[] {
  const all = words(query);
  const meaningful = all.filter((word) => !STOPWORDS.has(word));
  return meaningful.length > 0 ? meaningful : all;
}
/**
 * Words that mean the same thing to a person and different things to a vendor.
 *
 * The gap this closes is not a ranking gap, and no amount of re-weighting
 * reaches it: "latest email in inbox" contains no word that appears anywhere in
 * `users.messages.list`. Gmail says *mailbox*, a person says *inbox*; Google
 * Tasks says *task*, a person says *todo*; Drive says *file*, a person says
 * *document*. Every mail provider has the same problem, so the table is keyed on
 * the domain rather than on the vendor — which is what makes it worth having
 * one of, instead of a `keywords` line per provider that only ever helps that
 * provider.
 *
 * Groups are symmetric: any member expands to all the others. Kept small on
 * purpose — every entry widens what matches, and a synonym that is only
 * sometimes right is worse than none, because `holds` already covers plurals
 * and word endings.
 */
export const VOCABULARY: readonly (readonly string[])[] = [
  ['email', 'mail', 'message', 'correspondence'],
  ['inbox', 'mailbox'],
  ['latest', 'recent', 'newest', 'last'],
  ['find', 'search', 'lookup', 'look'],
  ['todo', 'task', 'reminder', 'checklist'],
  ['file', 'document', 'attachment'],
  ['folder', 'directory'],
  ['meeting', 'event', 'appointment'],
  ['calendar', 'schedule'],
  ['contact', 'person', 'people'],
  ['channel', 'conversation'],
  ['note', 'page'],
  ['ticket', 'issue'],
  ['delete', 'remove', 'trash'],
  // Not here: archive → label. It is how Gmail *implements* archiving, not what
  // the word means to anyone, and as a synonym it pulled "archive a message"
  // onto the tool that lists the label vocabulary. Where an implementation
  // detail is the answer, the manifest's own hint text is where it belongs —
  // `GMAIL_HINTS` already says so on the operation that does it.
];
/** Every term the caller typed, plus the words their domain also uses for it. */
export function expand(terms: readonly string[]): string[] {
  return [...confidence(terms).keys()];
}
/**
 * What the caller typed, against what this inferred on their behalf.
 *
 * A synonym has to widen what *matches* — that is the whole point, since
 * "inbox" appears nowhere in `users.messages.list`. But it must not weigh as
 * much as a word they actually typed, and the case that proves it is
 * `outlook_mail`: expanding "email" to "mail" made the provider's own id match
 * at full name weight, so a query about a Gmail inbox ranked an Outlook
 * operation first purely because that vendor spells its product name with the
 * synonym in it.
 *
 * So: matching is unweighted and generous, ordering is weighted and sceptical.
 */
export function confidence(terms: readonly string[]): Map<string, number> {
  const weights = new Map<string, number>(terms.map((term) => [term, 1]));
  for (const term of terms) {
    for (const group of VOCABULARY) {
      // Matched the way every other comparison here matches, which it was not.
      // Exact equality meant a plural never expanded: a caller typing
      // "meetings" got no synonyms at all, because the table says "meeting" —
      // so the query fell back to whatever the vendor's own words happened to
      // be, and the tiebreak decided. `holds` already covers the endings that
      // come up, and using it here is what makes the table apply to the way
      // people actually type.
      if (!holds(group, term)) continue;
      for (const word of group) if (!weights.has(word)) weights.set(word, SYNONYM);
    }
  }
  return weights;
}
/** What an inferred term is worth beside a typed one. */
export const SYNONYM = 0.45;
/**
 * Verbs, as the two naming conventions in use here spell them.
 *
 * Google puts the verb last (`users.messages.list`); MCP servers and GitHub put
 * it first (`list_pull_requests`). Neither position is reliable, so this asks
 * whether *any* word of the capability name is a known verb rather than which
 * word is in the verb slot.
 */
export const READ_VERBS = new Set([
  'list', 'get', 'search', 'find', 'read', 'retrieve', 'fetch', 'history', 'query', 'describe', 'view',
]);
export const WRITE_VERBS = new Set([
  'create', 'insert', 'add', 'update', 'patch', 'modify', 'delete', 'remove', 'trash', 'untrash',
  'send', 'post', 'write', 'set', 'move', 'copy', 'archive', 'batchmodify', 'clear', 'import',
]);
/** Reading many things, as opposed to reading one you can already name. */
export const ENUMERATE_VERBS = new Set(['list', 'search', 'find', 'query', 'history']);
/** What a capability does, as its own name gives it away. */
export function actionOf(name: readonly string[]): 'read' | 'write' | undefined {
  if (name.some((word) => WRITE_VERBS.has(word))) return 'write';
  if (name.some((word) => READ_VERBS.has(word))) return 'read';
  return undefined;
}
/**
 * Whether a capability enumerates, fetches one by identifier, or neither.
 *
 * The distinction `actionOf` cannot draw, and the one "latest email in inbox"
 * turns on: `get_message` and `list_messages` are both reads, so read/write
 * separated neither, and the tie fell back to alphabetical order again.
 *
 * It matters because a fetch is not merely a worse answer here, it is an
 * impossible one. "The latest email" supplies no message id, and `get` cannot
 * run without one — so the operation that would have to go first is the one
 * that finds the id. A caller who already had it would have said so.
 */
export function shapeOf_(name: readonly string[]): 'enumerate' | 'fetch' | undefined {
  if (name.some((word) => ENUMERATE_VERBS.has(word))) return 'enumerate';
  if (name.some((word) => word === 'get' || word === 'retrieve' || word === 'fetch')) return 'fetch';
  return undefined;
}
/**
 * Whether the caller asked about a category of thing rather than one thing.
 *
 * "what meetings do i have" names no verb, so nothing marked it as wanting
 * several — and `events.get` and `events.list` scored identically, leaving
 * `localeCompare` to answer with the one that needs an event id the caller has
 * not got. The plural is the whole signal, and it is the one an English speaker
 * is actually using: *meetings*, not *meeting*.
 *
 * `-ss` is excluded because *address*, *progress* and *access* are not plurals.
 */
export function plural(terms: readonly string[]): boolean {
  return terms.some((term) => term.length >= 4 && term.endsWith('s') && !term.endsWith('ss'));
}
/** Whether the query names something specific enough to fetch by. */
export function namesOne(terms: readonly string[]): boolean {
  return terms.some((term) => term === 'id' || term === 'this' || term === 'specific' || term === 'by');
}
/**
 * What the caller is asking to *do*, defaulting to reading.
 *
 * The default is the load-bearing half. "open pull requests" names no verb at
 * all — `open` is an adjective there — and without a default the tie falls to
 * `localeCompare`, which answers `create_pull_request`: a query that only wanted
 * to look at something ranked the tool that makes one. Reading is both the
 * commoner intent and the safer thing to put first, so ambiguity resolves that
 * way. An explicit write word still wins, which is what keeps "send an email"
 * and "add a reminder" pointing at the operations that write.
 */
export function intentOf(terms: readonly string[]): Intent {
  if (terms.some((term) => WRITE_VERBS.has(term))) return { wants: 'write', explicit: true };
  // A word that is a verb in front and a noun behind. "schedule an appointment"
  // asks for one to be made; "what is my schedule" asks to be shown one. English
  // gives the answer away by position, and nothing cheaper does.
  if (terms[0] !== undefined && AMBIGUOUS_VERBS.has(terms[0])) return { wants: 'write', explicit: true };
  if (terms.some((term) => READ_VERBS.has(term) || ENUMERATE_MARKERS.has(term))) {
    return { wants: 'read', explicit: true };
  }
  return { wants: 'read', explicit: false };
}
/**
 * Whether the caller said what they wanted done, or only what they wanted it
 * done to.
 *
 * The distinction is the difference between a preference and a penalty. Reading
 * is the right *assumption* for a query that names no verb — but assuming it and
 * then docking every write for disagreeing is not an assumption, it is a claim.
 * A bare `vendor_chat` names a provider and nothing else, and demoting that
 * provider's own tool for being a write let a *neighbouring* provider's read
 * back into an answer that had narrowed to one vendor.
 *
 * So an explicit verb moves things in both directions; an assumed one only
 * nudges its own kind up, and never pushes the other down.
 */
export type Intent = { readonly wants: 'read' | 'write'; readonly explicit: boolean };
/** Words that ask for several of something without naming a verb. */
export const ENUMERATE_MARKERS = new Set(['latest', 'recent', 'newest', 'last', 'all', 'every', 'unread']);
/** Words that write when they lead the sentence and read when they do not. */
export const AMBIGUOUS_VERBS = new Set(['schedule', 'book', 'draft', 'reply', 'forward', 'share', 'invite']);
/** The verbs that take something away, as distinct from the ones that add. */
export const DESTRUCTIVE_VERBS = new Set(['delete', 'remove', 'trash', 'clear', 'archive', 'untrash']);

