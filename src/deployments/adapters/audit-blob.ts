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

const MARKER_PREFIX = 'runs.closed/';

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

    async tail(query: AuditQuery = {}): Promise<AuditEvent[]> {
      const limit = query.limit ?? 50;
      const found: ChainedEvent[] = [];

      const start = now().getUTCFullYear();
      const floor = query.since ? query.since.getUTCFullYear() : start - TAIL_YEAR_WINDOW;

      for (let year = start; year >= floor && found.length < limit; year -= 1) {
        const keys = (await storage.list(`${year}/`))
          .map((entry) => entry.key)
          .filter((key) => !key.startsWith(MARKER_PREFIX))
          // Keys are compact ISO within a day and the day is in the path, so
          // lexicographic order is chronological — no parsing to sort.
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

        let lastStamp: string | null = null;

        for (const key of keys) {
          const stamp = stampOf(key);

          // Stop at the limit, but never mid-millisecond. Events sharing a
          // timestamp sort by the random half of their id, so cutting inside
          // one of those groups would keep an arbitrary subset of it — which
          // is how a rate-limited call, answered in well under a millisecond,
          // goes missing from the tail that exists to show it.
          if (found.length >= limit && stamp !== lastStamp) break;
          lastStamp = stamp;

          const bytes = await storage.get(key);
          if (bytes === null) continue;

          const record = decodeEvent(bytes);
          if (record && matches(record, query)) found.push(record);
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
      return found.slice(0, limit).reverse().map(strip);
    },

    async verify(): Promise<AuditVerification> {
      // Deliberately a full enumeration, unlike `tail`. A verification that
      // skipped part of the log would report `ok` for a range it never looked
      // at, and a chain is only checkable while it is contiguous — so there is
      // no range to narrow it by even if that were wanted.
      const records: StoredRecord[] = [];
      const markers: RunMarker[] = [];

      for (const entry of await storage.list('')) {
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
