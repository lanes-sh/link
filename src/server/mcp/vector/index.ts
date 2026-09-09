import { isTool } from '#connectivity';
import type { MergedCapability } from '../visibility.ts';
import { embed, readTable, similarity, type Table } from './table.ts';

/**
 * Retrieval by meaning, beside retrieval by word.
 *
 * The gap this closes is not a weighting gap and no amount of re-scoring
 * reaches it: "latest email in inbox" contains no word that appears anywhere in
 * `users.messages.list`. A vendor says *mailbox* and a person says *inbox*; a
 * vendor says *task* and a person says *todo*. A lexical ranker can only be
 * taught that by a table somebody writes and maintains, one domain at a time,
 * and the table is only ever as wide as its author's imagination.
 *
 * An embedding knows it already. Two texts that mean the same thing land near
 * each other whether or not they share a word, so the same mechanism that finds
 * a mailbox from *inbox* finds a subreddit from *community* without anybody
 * having thought of subreddits.
 *
 * What it cannot do is match an identifier. `users.messages.list` is not
 * English and its nearest neighbours in a semantic space are not what a caller
 * typing it wants — they want that row. So this is one half of a ranking rather
 * than a replacement for one: the words still decide when the caller used the
 * surface's own words, and meaning decides when they did not. `blend` in
 * `search-index.ts` is where the two meet, and `bench-retrieval.test.ts`
 * measures both halves separately so a regression can be attributed.
 */

/** Two vectors per capability, because one drowns the other. */
export interface Vectors {
  /** What it is called: the provider, the operation, and the title. */
  readonly name: Float32Array | undefined;
  /** What it says it does, in the vendor's own prose. */
  readonly prose: Float32Array | undefined;
}

export interface VectorIndex {
  readonly table: Table;
  readonly entries: ReadonlyMap<string, Vectors>;
}

/**
 * Where the vendored table sits, resolved from this module rather than the
 * process.
 *
 * `installRoot` walks up from the running module for the same reason: the CLI
 * is run out of a worktree, out of `node_modules`, and out of a container
 * image, and only the module's own URL is the same in all three.
 */
const TABLE = new URL('./table.lvec', import.meta.url);

let loaded: Table | undefined;
let unavailable = false;

/**
 * The table, read once per process and never on the startup path.
 *
 * Lazy because a `tools/list` must not pay for it: an instance may be created,
 * asked for its tool list, and replaced without a search ever arriving
 * (ADR-002), and seven megabytes read for nothing is seven megabytes of a cold
 * start somebody is waiting through.
 *
 * A missing or unreadable table is not an error. It is a ranking that has lost
 * half its signal, and the other half — the lexical scoring this has always
 * had — still answers. Failing the search instead would turn a packaging
 * mistake into an endpoint that cannot find anything.
 */
export function table(): Table | undefined {
  if (loaded || unavailable) return loaded;
  try {
    loaded = readTable(TABLE.pathname);
  } catch {
    unavailable = true;
  }
  return loaded;
}

/**
 * What a capability is embedded as.
 *
 * Split in two on purpose. A static embedding is an average over tokens, so a
 * four-hundred-word description and a three-word operation name cannot share
 * one vector without the description deciding it — and the description is the
 * half that every capability of a provider shares, because the manifest's
 * keywords are appended to all of them identically. Averaged together,
 * `users.drafts.list` and `users.messages.list` become nearly the same point.
 *
 * Kept apart, the prose finds the provider and the name separates that
 * provider's operations, which is exactly the division of labour the failure
 * asked for.
 */
function textsOf(id: string, entry: MergedCapability): { name: string; prose: string } {
  const summary = entry.discovered
    ? { title: entry.discovered.title, description: entry.discovered.description }
    : entry.capability && isTool(entry.capability)
      ? { title: entry.capability.title, description: entry.capability.description }
      : { title: undefined, description: '' };

  // The connections block is identical on every tool, so it would pull every
  // capability towards every other one. The same reason the lexical scoring
  // cuts it.
  const described = summary.description.split('\n\nAvailable connections')[0] ?? '';

  return {
    // Split the way an identifier is written rather than the way a sentence is:
    // `me.ListMessages` is three words and `users.messages.list` is three more,
    // and a table whose rows are English pieces has nothing for either until
    // they are separated. Without the camelCase split `ListMessages` tokenises
    // as a word nobody has ever seen.
    name: `${spaced(id)} ${summary.title ?? ''}`,
    // Truncated, because an average has no notion of position: the two
    // thousandth character of a reference document counts as much as the first,
    // and the first sentence is where an API says what an operation is for.
    prose: described.slice(0, PROSE),
  };
}

/** An identifier as the words it is made of. */
function spaced(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ');
}

/** How much of a description carries its meaning, measured rather than guessed. */
const PROSE = 600;

/**
 * Embed every capability once, for one generation of the catalogue.
 *
 * Built beside `mergeCapabilities` and memoised with it, so the cost is paid
 * per revision rather than per request. There is nothing to persist: the
 * vectors are derived from text this endpoint already holds, so a store for
 * them would be a second copy that can disagree with the first, plus an
 * invalidation rule, plus a migration — for something a hundred and sixty
 * capabilities rebuild in a few milliseconds.
 */
export function buildIndex(merged: ReadonlyMap<string, MergedCapability>): VectorIndex | undefined {
  const loadedTable = table();
  if (!loadedTable) return undefined;

  const entries = new Map<string, Vectors>();
  for (const [id, entry] of merged) {
    const texts = textsOf(id, entry);
    entries.set(id, {
      name: embed(texts.name, loadedTable),
      prose: embed(texts.prose, loadedTable),
    });
  }

  return { table: loadedTable, entries };
}

/**
 * How near a query is to one capability, on the better of its two readings.
 *
 * The maximum rather than a sum, and the prose discounted. A query either uses
 * the surface's vocabulary or the person's, and scoring both and adding them
 * rewards a capability for being *vaguely* like the question twice over —
 * which is how a provider's whole tool list ends up equidistant from every
 * query about that provider. Taking the better reading keeps the comparison
 * between capabilities rather than between the ways of reading one.
 *
 * The discount is because the two are not equally trustworthy: a name is short
 * and specific, and a description is long and shares its tail with every
 * sibling. A prose match has to be clearly better to win.
 */
export function nearness(query: Float32Array, vectors: Vectors): number {
  const byName = vectors.name ? similarity(query, vectors.name) : 0;
  const byProse = vectors.prose ? similarity(query, vectors.prose) : 0;
  return Math.max(byName, byProse * PROSE_TRUST);
}

const PROSE_TRUST = 0.45;

/** The query as a vector, or `undefined` if the table had none of its words. */
export function embedQuery(query: string, index: VectorIndex): Float32Array | undefined {
  return embed(query, index.table);
}
