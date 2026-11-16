import {
  auditKey,
  decodeEvent,
  encodeEvent,
  hashBytes,
  newRunId,
  stampOf,
  runMarkerKey,
  verifyChain,
  type AuditDraft,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
  type AuditStore,
  type AuditVerification,
  type ChainedEvent,
  type RunMarker,
  type StoredRecord,
} from '#audit';
import type { BlobStore } from '#stores/blobs';

/**
 * The audit log as objects in a blob store.
 *
 * One event is one object. That is the same layout locally and deployed — a
 * directory under the profile and a prefix in the bucket are the same tree —
 * so there is one sink, one reader, and no question about whether the two
 * behave alike.
 *
 * **Why objects rather than one appended file.** ADR-013 rejected file-backed
 * audit on the grounds that "a log file cannot enforce that at all; anything
 * that can open the file can rewrite it". True of one mutable file, and not
 * true of a set of immutable objects: a bucket retention policy or an
 * object hold makes each event genuinely unwritable, enforced by the platform
 * rather than by this interface declining to offer an `update`. Appending to
 * an object is also not a thing object storage does, so the alternative was a
 * read-modify-write of the whole log per call.
 *
 * The cost, stated rather than discovered later: an event is a few hundred
 * bytes against a filesystem block of four kilobytes, so locally this spends
 * roughly five to ten times the space an appended file would. Retention is the
 * answer when that matters, and `#audit` is explicit that it belongs in an
 * operator-run command outside this interface — or, deployed, in a bucket
 * lifecycle rule that needs no code at all.
 */

/**
 * How far back `tail` will look for its newest N.
 *
 * A bound is needed because finding the newest keys without enumerating every
 * key means guessing where to look. One list per year is cheap and returns
 * keys without reading a single object, so ten of them costs little even when
 * the log is empty.
 *
 * `tail` is a tail: returning fewer than asked because the log is older than
 * this window is the correct answer, not a silent truncation of a search.
 * `verify` does not use this — it enumerates everything, because it must.
 */
const TAIL_YEAR_WINDOW = 10;

/**
 * How many stored records one `tail` may read before it stops looking.
 *
 * The year window bounds the *listing*; this bounds the *reading*, and until
 * there was a predicate on something only the body carries, nothing needed it.
 * A key says when an event happened and nothing about whose profile it was, so
 * narrowing to one profile cannot narrow the walk — a quiet profile in a busy
 * workspace is found by reading past everybody else's rows. Unbounded, one
 * request for a profile that has written nothing reads ten years of the log.
 *
 * So the walk stops, and `complete: false` says that it did. A short answer
 * that cannot say it is short is the defect this whole change is about, and
 * reproducing it one layer down would be its own joke.
 *
 * Set from a measurement rather than from taste, because the first guess at it
 * was wrong by an order of magnitude. Five thousand objects read one at a time
 * against a bucket is minutes, and the request this serves is answered inside
 * one HTTP timeout or not at all. Read in batches (see `tail`) a thousand is
 * roughly a second, which leaves room under that timeout for the listing and
 * the response beside it.
 */
const SCAN_BUDGET = 1_000;

/**
 * How many objects one batch of the walk has in flight.
 *
 * The walk is latency-bound, not bandwidth-bound: an event is a few hundred
 * bytes and a round trip is tens of milliseconds, so the whole cost is the
 * number of times it waits. Thirty-two turns a thousand sequential waits into
 * about thirty.
 */
const READ_BATCH = 32;

const MARKER_PREFIX = 'runs.closed/';

/**
 * Whether a key is something this store wrote, rather than something the OS did.
 *
 * `verify` enumerates the whole prefix and feeds every non-marker key to the
 * chain, so a `.DS_Store` that Finder dropped in the audit directory arrived as
 * a record, failed to decode, and was reported as `malformed run ? at seq -1` —
 * the whole log **BROKEN** because somebody opened the folder. Seen on a real
 * workspace, where the file had ridden through two contract migrations.
 *
 * A dotfile is the narrowest rule that covers it: no key this store writes
 * begins with a dot, in either segment. Deliberately not "does it look like an
 * event" — a corrupt event must still fail loudly, because reporting `ok` for a
 * record it could not read is the one thing `verify` must never do.
 */
function isOurs(key: string): boolean {
  return !key.split('/').some((segment) => segment.startsWith('.'));
}


export interface BlobAuditOptions {
  /** Scoped to the audit root — `data/<profile>/audit.log` or its bucket prefix. */
  readonly storage: BlobStore;
  readonly now?: () => Date;
  /** Overridable so a test can assert a chain across a known run id. */
  readonly run?: string;
}

export function createBlobAuditStore(options: BlobAuditOptions): AuditStore {
  const storage = options.storage;
  const now = options.now ?? ((): Date => new Date());
  const run = options.run ?? newRunId();

  let seq = 0;
  let lastHash: string | null = null;

  return {
    async append(draft: AuditDraft): Promise<AuditEvent> {
      const event: AuditEvent = { ...draft, id: `evt_${crypto.randomUUID()}`, timestamp: now() };

      // Every read and write of the chain state happens before the first
      // await, so two overlapping appends still get consecutive `seq` values
      // and correctly linked hashes. Objects may then land out of order, which
      // does not matter: the chain is ordered by `seq`, not by arrival.
      const bytes = encodeEvent({ ...event, run, seq, prev: lastHash });
      seq += 1;
      lastHash = hashBytes(bytes);

      await storage.put(auditKey(event), bytes, { contentType: 'application/json' });
      return event;
    },

    async close(): Promise<void> {
      // A run that wrote nothing has no tail to truncate, so it needs no marker.
      if (lastHash === null) return;

      const marker: RunMarker = { run, events: seq, last: lastHash };
      await storage.put(
        runMarkerKey(run),
        new TextEncoder().encode(JSON.stringify(marker)),
        { contentType: 'application/json' },
      );
    },

    async tail(query: AuditQuery = {}): Promise<AuditPage> {
      const limit = query.limit ?? 50;
      const budget = query.budget ?? SCAN_BUDGET;
      const found: ChainedEvent[] = [];

      // Records read, not records kept. The caller is being told how much of
      // the log this answer speaks for, and a filtered walk reads far more
      // than it returns — which is the whole reason the number is reported.
      let scanned = 0;
      let complete = true;

      const start = now().getUTCFullYear();
      const floor = query.since ? query.since.getUTCFullYear() : start - TAIL_YEAR_WINDOW;

      for (let year = start; year >= floor && found.length < limit && complete; year -= 1) {
        const keys = (await storage.list(`${year}/`))
          .map((entry) => entry.key)
          .filter((key) => !key.startsWith(MARKER_PREFIX) && isOurs(key))
          // Keys are compact ISO within a day and the day is in the path, so
          // lexicographic order is chronological — no parsing to sort.
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

        let lastStamp: string | null = null;
        let enough = false;

        // Read in ordered batches rather than one key at a time. A predicate on
        // something only the body carries means the walk reads objects it will
        // discard, and one round trip each is what that costs: against a bucket
        // this took ten to fifteen seconds for twenty rows, and the default
        // hundred exceeded the request timeout outright — correct, and too slow
        // to use. Sequential was never a requirement; it was just what reading
        // one key at a time looked like.
        //
        // Ordering is unchanged. The batch is a slice of the same descending
        // key order and its results are examined in that order, so the limit
        // and the mid-millisecond rule below see exactly the sequence they saw
        // before. The cost is over-reading up to a batch at the boundary, which
        // `scanned` counts honestly because it is paid.
        // Advanced by what was actually taken, not by the batch size: the
        // budget can cut a batch short, and stepping over the difference would
        // skip keys and miss the next budget check at the same time.
        let at = 0;
        while (at < keys.length && !enough) {
          // Bounds the fetch, not just the bookkeeping — a budget checked after
          // the read would report the cost rather than cap it.
          const room = budget - scanned;
          if (room <= 0) {
            complete = false;
            break;
          }

          const take = Math.min(READ_BATCH, room, keys.length - at);
          const slice = keys.slice(at, at + take);
          const bodies = await Promise.all(slice.map((key) => storage.get(key)));
          scanned += take;
          at += take;

          for (const [offset, key] of slice.entries()) {
            const stamp = stampOf(key);

            // Stop at the limit, but never mid-millisecond. Events sharing a
            // timestamp sort by the random half of their id, so cutting inside
            // one of those groups would keep an arbitrary subset of it — which
            // is how a rate-limited call, answered in well under a millisecond,
            // goes missing from the tail that exists to show it.
            if (found.length >= limit && stamp !== lastStamp) {
              enough = true;
              break;
            }
            lastStamp = stamp;

            const bytes = bodies[offset];
            if (bytes === null || bytes === undefined) continue;

            const record = decodeEvent(bytes);
            if (record && matches(record, query)) found.push(record);
          }
        }
      }

      // `seq` is the tiebreaker the key cannot carry — the same job SQLite's
      // implicit `rowid` did. Within one writer it is the true order; across
      // two writers in the same millisecond there is no true order to find.
      found.sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime() || b.seq - a.seq,
      );

      // Collected newest-first so the limit keeps the most recent; presented
      // oldest-first, which is how a log is read.
      return { events: found.slice(0, limit).reverse().map(strip), complete, scanned };
    },

    async verify(): Promise<AuditVerification> {
      // Deliberately a full enumeration, unlike `tail`. A verification that
      // skipped part of the log would report `ok` for a range it never looked
      // at, and a chain is only checkable while it is contiguous — so there is
      // no range to narrow it by even if that were wanted.
      const records: StoredRecord[] = [];
      const markers: RunMarker[] = [];

      for (const entry of await storage.list('')) {
        if (!isOurs(entry.key)) continue;

        const bytes = await storage.get(entry.key);
        if (bytes === null) continue;

        if (entry.key.startsWith(MARKER_PREFIX)) {
          const marker = readMarker(bytes);
          if (marker) markers.push(marker);
          continue;
        }
        records.push({ key: entry.key, bytes });
      }

      return verifyChain(records, markers);
    },
  };
}

function strip(record: ChainedEvent): AuditEvent {
  const { run: _run, seq: _seq, prev: _prev, ...event } = record;
  return event;
}

function matches(event: AuditEvent, query: AuditQuery): boolean {
  if (query.since && event.timestamp < query.since) return false;
  // Inside `matches` rather than applied to the result, and that is the fix.
  // The limit is spent during enumeration — see the guard above — so a
  // predicate applied afterwards narrows an already-truncated set and returns
  // one profile's share of the newest N instead of its own newest N.
  //
  // An empty array reaches here as a filter that matches nothing, which is
  // deliberate: it is what a caller asking about a profile they may not reach
  // is answered with. `query.profiles &&` is the guard, never `?.length`.
  if (query.profiles && !query.profiles.includes(event.profile)) return false;
  if (query.provider && event.provider !== query.provider) return false;
  if (query.connection && event.connection !== query.connection) return false;
  if (query.capability && event.capability !== query.capability) return false;
  if (query.deniedOnly && event.authorization === 'allowed') return false;
  return true;
}

function readMarker(bytes: Uint8Array): RunMarker | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof parsed['run'] !== 'string') return null;
    if (typeof parsed['events'] !== 'number') return null;
    if (typeof parsed['last'] !== 'string') return null;
    return { run: parsed['run'], events: parsed['events'], last: parsed['last'] };
  } catch {
    return null;
  }
}
