import { createHash } from 'node:crypto';
import type { AuditEvent } from './index.ts';

/**
 * The integrity envelope around an event, and the record format on disk.
 *
 * One event is one object. `prev` holds the SHA-256 of the bytes of the
 * previous record *of the same run*, so altering or removing a record breaks
 * every link after it.
 *
 * **Why the chain is per run and not per file.** There is no file. Events are
 * separate objects, several Cloud Run instances write concurrently, and a
 * single global chain would need a lock across all of them — which is the
 * database this change exists to remove. A run is one writer process, so its
 * sequence is naturally ordered without coordinating with anybody.
 *
 * What this proves, and what it does not:
 *
 *   - A `seq` gap, or a `prev` that does not match, proves a record was
 *     **removed from the middle of a run, or altered**. That is the case a
 *     database could not detect either: nothing stopped `UPDATE audit_events`.
 *   - Truncating a run's **tail** is invisible on its own, because nothing
 *     points forward. `closeRun` writes a marker at graceful shutdown so a
 *     clean exit is checkable; a killed process leaves a run that verifies as
 *     open, which is honest rather than reassuring.
 *   - Deleting a whole run nobody knew existed is undetectable. Runs are not
 *     enumerated anywhere else, and inventing a registry to hold them would
 *     just move the same problem up one level.
 */
export interface ChainFields {
  /** One writer process. */
  readonly run: string;
  /** Monotonic within `run`, from zero. */
  readonly seq: number;
  /** SHA-256 of the previous record's bytes in this run; `null` for the first. */
  readonly prev: string | null;
}

export type ChainedEvent = AuditEvent & ChainFields;

/** A record as it was stored, kept as bytes because that is what the hash covers. */
export interface StoredRecord {
  readonly key: string;
  readonly bytes: Uint8Array;
}

export interface ChainBreak {
  readonly run: string;
  readonly seq: number;
  readonly kind: 'gap' | 'hash' | 'malformed';
  readonly detail: string;
}

export interface AuditVerification {
  readonly events: number;
  readonly runs: number;
  readonly ok: boolean;
  readonly breaks: readonly ChainBreak[];
}

/** What `closeRun` writes, so a cleanly-stopped run can be checked for truncation. */
export interface RunMarker {
  readonly run: string;
  readonly events: number;
  readonly last: string;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function newRunId(): string {
  return `r_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Where one event is stored.
 *
 * Date-partitioned because `BlobStore.list` paginates to completion and takes
 * no limit: a flat prefix would make `tail` enumerate every event ever written,
 * which is a slow directory walk locally and a paid one deployed.
 *
 * The timestamp is compact ISO basic format — fixed width, no colons, and
 * lexicographically chronological, so sorting keys within a day sorts by time
 * without parsing anything. Colons are legal in object keys but awkward in a
 * local path, and the two layouts have to stay identical.
 */
export function auditKey(event: Pick<AuditEvent, 'id' | 'timestamp'>): string {
  const iso = event.timestamp.toISOString();
  const stamp = iso.replaceAll('-', '').replaceAll(':', '').replace('.', '');
  return `${dayPrefix(event.timestamp)}${stamp}-${event.id}.json`;
}

/** The `YYYY/MM/DD/` prefix a day's events share. */
export function dayPrefix(date: Date): string {
  return `${date.toISOString().slice(0, 10).replaceAll('-', '/')}/`;
}

/**
 * The part of a key two events written in the same millisecond share.
 *
 * A reader sorting by key alone cannot order those two, because what follows
 * is a random id. `seq` is the tiebreaker — this exists so a reader can tell
 * where the ambiguity starts and read far enough to resolve it.
 *
 * The first `-` after the day prefix: the stamp has had its dashes stripped
 * and the day is separated by slashes, so nothing before the separator can
 * contain one.
 */
export function stampOf(key: string): string {
  const separator = key.indexOf('-', 'YYYY/MM/DD/'.length);
  return separator === -1 ? key : key.slice(0, separator);
}

/** Where a run's close marker lives. Under a dot so it cannot look like a day. */
export function runMarkerKey(run: string): string {
  return `runs.closed/${run}.json`;
}

/**
 * The record, with keys written in a fixed order.
 *
 * Verification hashes the bytes it read rather than re-serialising, so key
 * order is not load-bearing for correctness — but a stable order keeps two
 * records of the same shape diffable, which is worth the explicit construction.
 */
export function encodeEvent(event: ChainedEvent): Uint8Array {
  const record: Record<string, unknown> = {
    run: event.run,
    seq: event.seq,
    prev: event.prev,
    id: event.id,
    timestamp: event.timestamp.toISOString(),
    profile: event.profile,
    principal: event.principal,
    ...(event.clientLabel !== undefined ? { clientLabel: event.clientLabel } : {}),
    provider: event.provider,
    ...(event.connection !== undefined ? { connection: event.connection } : {}),
    capability: event.capability,
    arguments: event.arguments,
    authorization: event.authorization,
    status: event.status,
    durationMs: event.durationMs,
    ...(event.error !== undefined ? { error: event.error } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(record));
}

/**
 * Parse a record, or `null` if it is not one.
 *
 * A record that will not parse is a record nothing can use, and one corrupt
 * object must not take down a `tail` over the thousand beside it. `verify` is
 * the command that reports it as `malformed`; readers skip it.
 */
export function decodeEvent(bytes: Uint8Array): ChainedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const { run, seq, prev, id, timestamp } = record;

  if (typeof run !== 'string' || typeof seq !== 'number' || typeof id !== 'string') return null;
  if (prev !== null && typeof prev !== 'string') return null;
  if (typeof timestamp !== 'string') return null;

  const when = new Date(timestamp);
  if (Number.isNaN(when.getTime())) return null;

  return {
    run,
    seq,
    prev,
    id,
    timestamp: when,
    profile: String(record['profile'] ?? ''),
    principal: String(record['principal'] ?? ''),
    ...(typeof record['clientLabel'] === 'string' ? { clientLabel: record['clientLabel'] } : {}),
    provider: String(record['provider'] ?? ''),
    ...(typeof record['connection'] === 'string' ? { connection: record['connection'] } : {}),
    capability: String(record['capability'] ?? ''),
    arguments: (record['arguments'] ?? {}) as Readonly<Record<string, unknown>>,
    authorization: record['authorization'] as AuditEvent['authorization'],
    status: record['status'] as AuditEvent['status'],
    durationMs: typeof record['durationMs'] === 'number' ? record['durationMs'] : 0,
    ...(isError(record['error']) ? { error: record['error'] } : {}),
  };
}

function isError(value: unknown): value is { kind: string; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['kind'] === 'string' && typeof candidate['message'] === 'string';
}

/**
 * Walk every run and report the first break in each.
 *
 * One break per run rather than every downstream link: a single altered record
 * invalidates every `prev` after it, and reporting three hundred consequences
 * of one edit buries the edit.
 */
export function verifyChain(
  records: readonly StoredRecord[],
  markers: readonly RunMarker[] = [],
): AuditVerification {
  const runs = new Map<string, Array<{ record: ChainedEvent; hash: string }>>();
  const breaks: ChainBreak[] = [];
  let events = 0;

  for (const stored of records) {
    const record = decodeEvent(stored.bytes);
    if (!record) {
      breaks.push({ run: '?', seq: -1, kind: 'malformed', detail: stored.key });
      continue;
    }
    events += 1;
    const bucket = runs.get(record.run) ?? [];
    bucket.push({ record, hash: hashBytes(stored.bytes) });
    runs.set(record.run, bucket);
  }

  for (const [run, entries] of runs) {
    entries.sort((a, b) => a.record.seq - b.record.seq);

    let previousHash: string | null = null;
    let expected = 0;
    let broken = false;

    for (const { record, hash } of entries) {
      if (broken) break;

      if (record.seq !== expected) {
        breaks.push({
          run,
          seq: expected,
          kind: 'gap',
          detail: `expected seq ${expected}, found ${record.seq}`,
        });
        broken = true;
        break;
      }
      if (record.prev !== previousHash) {
        breaks.push({
          run,
          seq: record.seq,
          kind: 'hash',
          detail: `prev is ${record.prev ?? 'null'}, expected ${previousHash ?? 'null'}`,
        });
        broken = true;
        break;
      }
      previousHash = hash;
      expected += 1;
    }

    if (broken) continue;

    // A closed run states how far it got, which is the only way to notice that
    // its tail was cut off — nothing inside a chain points forward.
    const marker = markers.find((candidate) => candidate.run === run);
    if (marker && marker.events !== entries.length) {
      breaks.push({
        run,
        seq: entries.length,
        kind: 'gap',
        detail: `run closed at ${marker.events} events, found ${entries.length}`,
      });
    }
  }

  return { events, runs: runs.size, ok: breaks.length === 0, breaks };
}
