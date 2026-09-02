import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeAuditSinkContract, type ContractSink } from '#audit/conformance.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import { createBlobAuditStore } from './audit-blob.ts';
import { createFilesystemBlobStore } from './filesystem.ts';

/**
 * The behavioural half lives in `#audit/conformance.ts` and runs below against
 * both blob stores, because the whole point of this layout is that a local
 * directory and a bucket prefix are the same tree. What stays here is what is
 * specific to objects: the keys they land on, and the chain's own arithmetic.
 */

function fixtureOver(storage: BlobStore, dispose?: () => Promise<void>): ContractSink {
  return {
    open: (options) => createBlobAuditStore({ storage, ...options }),
    keys: async () => (await storage.list('')).map((entry) => entry.key),
    read: (key) => storage.get(key),
    write: (key, bytes) => storage.put(key, bytes),
    remove: (key) => storage.delete(key),
    ...(dispose ? { dispose } : {}),
  };
}

describeAuditSinkContract('memory', () => fixtureOver(createMemoryBlobStore()));

describeAuditSinkContract('filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-audit-'));
  return fixtureOver(createFilesystemBlobStore({ root }), () =>
    rm(root, { recursive: true, force: true }),
  );
});

describe('audit-blob: the keys it writes', () => {
  const draft = {
    profile: 'personal',
    principal: 'personal:owner',
    provider: 'gmail',
    connection: 'gmail.main',
    capability: 'gmail.users_messages_list',
    arguments: {},
    authorization: 'allowed',
    status: 'ok',
    durationMs: 1,
  } as const;

  test('one object per event, under a date-partitioned key', async () => {
    const storage = createMemoryBlobStore();
    const sink = createBlobAuditStore({
      storage,
      now: () => new Date(Date.UTC(2026, 7, 12, 10, 4, 31, 221)),
    });

    const event = await sink.append(draft);

    expect((await storage.list('')).map((entry) => entry.key)).toEqual([
      `2026/08/12/20260812T100431221Z-${event.id}.json`,
    ]);
  });

  test('keys sort chronologically as strings, so tail needs no parsing', async () => {
    // The compact form has no colons and a fixed width precisely so that
    // lexicographic order is time order. A key that sorted differently from
    // its timestamp would make `tail` return the wrong events with no error.
    const storage = createMemoryBlobStore();
    const times = [
      new Date(Date.UTC(2026, 7, 12, 9, 59, 59, 999)),
      new Date(Date.UTC(2026, 7, 12, 10, 0, 0, 1)),
      new Date(Date.UTC(2026, 8, 1, 0, 0, 0, 0)),
    ];
    let index = 0;
    const sink = createBlobAuditStore({ storage, now: () => times[index++]! });

    for (const _ of times) await sink.append(draft);

    const keys = (await storage.list('')).map((entry) => entry.key);
    expect([...keys].sort()).toEqual(keys);
  });

  test('the run marker is not mistaken for a day', async () => {
    // `runs.closed/` carries a dot, which no date component can, so a listing
    // of the log cannot confuse the two.
    const storage = createMemoryBlobStore();
    const sink = createBlobAuditStore({ storage, run: 'r_abc', now: () => new Date() });

    await sink.append(draft);
    await sink.close();

    const keys = (await storage.list('')).map((entry) => entry.key);
    expect(keys).toContain('runs.closed/r_abc.json');
    expect(keys.filter((key) => /^\d{4}\//.test(key))).toHaveLength(1);
  });

  test('each record links to the bytes of the one before it', async () => {
    const storage = createMemoryBlobStore();
    // A ticking clock, because two appends inside one millisecond share a key
    // prefix and then sort by the random half of the id. That is exactly why
    // `verify` orders by seq rather than by key; here it would just make the
    // test's own indexing arbitrary.
    let at = Date.UTC(2026, 7, 12, 10, 0, 0);
    const sink = createBlobAuditStore({
      storage,
      run: 'r_abc',
      now: () => new Date((at += 1000)),
    });

    await sink.append(draft);
    await sink.append(draft);

    const keys = (await storage.list(''))
      .map((entry) => entry.key)
      .filter((key) => !key.startsWith('runs.closed/'))
      .sort();

    const first = JSON.parse(new TextDecoder().decode((await storage.get(keys[0]!))!)) as Record<
      string,
      unknown
    >;
    const second = JSON.parse(new TextDecoder().decode((await storage.get(keys[1]!))!)) as Record<
      string,
      unknown
    >;

    expect(first['run']).toBe('r_abc');
    expect(first['seq']).toBe(0);
    expect(first['prev']).toBeNull();

    expect(second['seq']).toBe(1);
    expect(second['prev']).toBe(
      new Bun.CryptoHasher('sha256').update((await storage.get(keys[0]!))!).digest('hex'),
    );
  });

  test('concurrent appends still produce one unbroken chain', async () => {
    // Sequence and hash are assigned before the first await, so overlapping
    // calls cannot interleave into a fork. Objects may land out of order,
    // which is fine: the chain is ordered by seq, not by arrival.
    const storage = createMemoryBlobStore();
    const sink = createBlobAuditStore({ storage });

    await Promise.all(Array.from({ length: 20 }, () => sink.append(draft)));

    const report = await sink.verify();
    expect(report.ok).toBe(true);
    expect(report.events).toBe(20);
    expect(report.runs).toBe(1);
  });
});

/**
 * What the operating system leaves in the directory, which is not an event.
 *
 * `verify` enumerates the whole prefix and fed every non-marker key to the
 * chain, so a `.DS_Store` that Finder dropped in the audit directory came back
 * as `malformed run ? at seq -1` and the whole log as **BROKEN** — on a real
 * workspace, where the file had ridden through two contract migrations. The one
 * command whose job is to say whether the log was tampered with, crying wolf
 * because somebody opened the folder.
 */
describe('audit-blob: a dotfile in the audit directory', () => {
  const draft = {
    profile: 'personal',
    principal: 'personal:owner',
    provider: 'gmail',
    connection: 'gmail.con1',
    capability: 'gmail.users_messages_list',
    arguments: {},
    authorization: 'allowed',
    status: 'ok',
    durationMs: 1,
  } as const;

  const seeded = async (): Promise<ReturnType<typeof createMemoryBlobStore>> => {
    const storage = createMemoryBlobStore();
    const sink = createBlobAuditStore({
      storage,
      now: () => new Date(Date.UTC(2026, 7, 12, 10, 4, 31, 221)),
    });
    await sink.append(draft);
    await sink.append(draft);
    return storage;
  };

  test('does not break the chain', async () => {
    const storage = await seeded();
    await storage.put('.DS_Store', new Uint8Array([0, 1, 2, 3]));
    await storage.put('2026/.DS_Store', new Uint8Array([0, 1, 2, 3]));
    await storage.put('2026/08/.DS_Store', new Uint8Array([0, 1, 2, 3]));

    const verified = await createBlobAuditStore({ storage }).verify();

    expect(verified.ok).toBe(true);
    expect(verified.events).toBe(2);
  });

  test('and is not returned as an event by tail', async () => {
    const storage = await seeded();
    await storage.put('2026/.DS_Store', new Uint8Array([0, 1, 2, 3]));

    const tailed = await createBlobAuditStore({
      storage,
      now: () => new Date(Date.UTC(2026, 7, 12, 10, 4, 31, 221)),
    }).tail({ limit: 10 });

    expect(tailed).toHaveLength(2);
  });

  test('but a real event that will not decode still fails, loudly', async () => {
    // The rule is "not ours", not "does not look like an event". Reporting ok
    // for a record it could not read is the one thing verify must never do.
    const storage = await seeded();
    await storage.put('2026/08/12/20260812T100431999Z-broken.json', new Uint8Array([9, 9, 9]));

    expect((await createBlobAuditStore({ storage }).verify()).ok).toBe(false);
  });
});
