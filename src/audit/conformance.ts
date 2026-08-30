import { describe, expect, test } from 'bun:test';
import type { AuditDraft, AuditStore } from './index.ts';

/**
 * One behavioural suite, run against every backing store.
 *
 * The same reasoning as `#stores/blobs/conformance.ts`: an operator who
 * switches targets must not find that the log they could read locally is one
 * their deployed target answers differently. The chain in particular is worth
 * holding to one rule — a `verify` that passes on a filesystem and misses a
 * tampered record in a bucket would be worse than no `verify` at all.
 *
 * The fixture exposes raw key access because the interesting half of this
 * suite is what happens when somebody edits the log behind the endpoint's
 * back, and there is no honest way to test that through the interface — the
 * absence of a way to mutate an event is the guarantee being tested.
 */
export interface ContractSink {
  open(options?: { now?: () => Date; run?: string }): AuditStore;
  keys(): Promise<string[]>;
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  dispose?(): Promise<void>;
}

function draft(overrides: Partial<AuditDraft> = {}): AuditDraft {
  return {
    profile: 'personal',
    principal: 'personal:owner',
    provider: 'gmail',
    connection: 'gmail.main',
    capability: 'gmail.users_messages_list',
    arguments: { q: '<string:12>' },
    authorization: 'allowed',
    status: 'ok',
    durationMs: 12,
    ...overrides,
  };
}

/** A clock that advances a second per call, so ordering is deterministic. */
function ticking(start = Date.UTC(2026, 7, 12, 10, 0, 0)): () => Date {
  let at = start;
  return () => {
    at += 1000;
    return new Date(at);
  };
}

export function describeAuditSinkContract(
  name: string,
  create: () => Promise<ContractSink> | ContractSink,
): void {
  describe(`audit sink contract: ${name}`, () => {
    async function use(body: (fixture: ContractSink) => Promise<void>): Promise<void> {
      const fixture = await create();
      try {
        await body(fixture);
      } finally {
        await fixture.dispose?.();
      }
    }

    describe('writing and reading back', () => {
      test('append stamps an id and a timestamp, and tail returns the event', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          const written = await sink.append(draft());

          expect(written.id).toMatch(/^evt_/);
          expect(written.timestamp).toBeInstanceOf(Date);

          const [read] = await sink.tail();
          expect(read?.id).toBe(written.id);
          expect(read?.capability).toBe('gmail.users_messages_list');
          expect(read?.timestamp.getTime()).toBe(written.timestamp.getTime());
        });
      });

      test('tail presents oldest first', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ capability: 'one' }));
          await sink.append(draft({ capability: 'two' }));
          await sink.append(draft({ capability: 'three' }));

          expect((await sink.tail()).map((event) => event.capability)).toEqual([
            'one',
            'two',
            'three',
          ]);
        });
      });

      test('a limit keeps the newest, not the first written', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          for (const capability of ['one', 'two', 'three', 'four']) {
            await sink.append(draft({ capability }));
          }

          expect((await sink.tail({ limit: 2 })).map((event) => event.capability)).toEqual([
            'three',
            'four',
          ]);
        });
      });

      test('events sharing a millisecond keep their order', async () => {
        await use(async (fixture) => {
          // Keys are timestamped to the millisecond and then disambiguated by a
          // random id, so sorting by key alone leaves same-millisecond events in
          // arbitrary order. `seq` is the tiebreaker — the job SQLite's implicit
          // `rowid` used to do.
          //
          // This is not a corner case. A refusal is answered without touching a
          // provider, so a rate-limited call and the call before it routinely
          // land in the same millisecond, and getting this wrong hides the
          // denial the log exists to show.
          const frozen = new Date(Date.UTC(2026, 7, 12, 10, 0, 0, 0));
          const sink = fixture.open({ now: () => frozen });

          await sink.append(draft({ capability: 'first' }));
          await sink.append(draft({ capability: 'second' }));
          await sink.append(draft({ capability: 'third', authorization: 'denied_rate_limited' }));

          expect((await sink.tail()).map((event) => event.capability)).toEqual([
            'first',
            'second',
            'third',
          ]);

          // And a limit has to cut by that order too, not by the random half
          // of a key: the newest is the denial.
          expect((await sink.tail({ limit: 1 })).map((event) => event.capability)).toEqual([
            'third',
          ]);
        });
      });

      test('redacted arguments survive nesting', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          const args = { query: '<string:12>', nested: { keep: 1, list: [1, 'two', null] } };
          await sink.append(draft({ arguments: args }));

          expect((await sink.tail())[0]?.arguments).toEqual(args);
        });
      });

      test('optional fields are absent rather than null when unset', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ arguments: {} }));

          const [event] = await sink.tail();
          expect(event).not.toHaveProperty('clientLabel');
          expect(event).not.toHaveProperty('error');
        });
      });

      test('an error is carried through', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(
            draft({ status: 'error', error: { kind: 'provider_error', message: 'upstream 500' } }),
          );

          expect((await sink.tail())[0]?.error).toEqual({
            kind: 'provider_error',
            message: 'upstream 500',
          });
        });
      });

      test('events written either side of midnight both come back', async () => {
        await use(async (fixture) => {
          // The store is date-partitioned, so a day boundary is the seam where
          // a tail that only looked at one prefix would quietly lose half the log.
          const times = [
            new Date(Date.UTC(2026, 7, 12, 23, 59, 59)),
            new Date(Date.UTC(2026, 7, 13, 0, 0, 1)),
          ];
          let index = 0;
          const sink = fixture.open({ now: () => times[index++] ?? times[times.length - 1]! });

          await sink.append(draft({ capability: 'before' }));
          await sink.append(draft({ capability: 'after' }));

          expect((await sink.tail()).map((event) => event.capability)).toEqual([
            'before',
            'after',
          ]);
        });
      });
    });

    describe('filters', () => {
      test('each predicate narrows the log', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ provider: 'gmail', capability: 'gmail.list' }));
          await sink.append(
            draft({ provider: 'drive', connection: 'drive.main', capability: 'drive.list' }),
          );
          await sink.append(
            draft({ provider: 'vault', capability: 'vault.get', authorization: 'denied_by_policy' }),
          );

          expect((await sink.tail({ provider: 'drive' })).map((e) => e.capability)).toEqual([
            'drive.list',
          ]);
          expect((await sink.tail({ connection: 'drive.main' })).map((e) => e.capability)).toEqual([
            'drive.list',
          ]);
          expect((await sink.tail({ capability: 'gmail.list' })).map((e) => e.provider)).toEqual([
            'gmail',
          ]);
          expect((await sink.tail({ deniedOnly: true })).map((e) => e.capability)).toEqual([
            'vault.get',
          ]);
        });
      });

      test('since excludes anything older', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          const first = await sink.append(draft({ capability: 'old' }));
          await sink.append(draft({ capability: 'new' }));

          const after = new Date(first.timestamp.getTime() + 1);
          expect((await sink.tail({ since: after })).map((e) => e.capability)).toEqual(['new']);
        });
      });
    });

    describe('the chain', () => {
      test('an untouched log verifies', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          for (const capability of ['one', 'two', 'three']) {
            await sink.append(draft({ capability }));
          }

          const report = await sink.verify();
          expect(report.ok).toBe(true);
          expect(report.events).toBe(3);
          expect(report.runs).toBe(1);
          expect(report.breaks).toEqual([]);
        });
      });

      test('editing a record is caught', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ capability: 'one' }));
          await sink.append(draft({ capability: 'two' }));
          await sink.append(draft({ capability: 'three' }));

          // Rewrite the middle event as though it had been allowed, which is
          // the edit somebody covering their tracks would actually make.
          const keys = (await fixture.keys()).filter((key) => key.endsWith('.json')).sort();
          const target = keys[1]!;
          const original = new TextDecoder().decode((await fixture.read(target))!);
          await fixture.write(
            target,
            new TextEncoder().encode(original.replace('"two"', '"rewritten"')),
          );

          const report = await sink.verify();
          expect(report.ok).toBe(false);
          expect(report.breaks[0]?.kind).toBe('hash');
        });
      });

      test('deleting a record from the middle is caught', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ capability: 'one' }));
          await sink.append(draft({ capability: 'two' }));
          await sink.append(draft({ capability: 'three' }));

          const keys = (await fixture.keys()).filter((key) => key.endsWith('.json')).sort();
          await fixture.remove(keys[1]!);

          const report = await sink.verify();
          expect(report.ok).toBe(false);
          expect(report.breaks[0]?.kind).toBe('gap');
        });
      });

      test('truncating a closed run is caught', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ capability: 'one' }));
          await sink.append(draft({ capability: 'two' }));
          await sink.append(draft({ capability: 'three' }));
          await sink.close();

          const keys = (await fixture.keys())
            .filter((key) => key.endsWith('.json') && !key.startsWith('runs.closed/'))
            .sort();
          await fixture.remove(keys[keys.length - 1]!);

          // Nothing inside a chain points forward, so the close marker is the
          // only thing that can notice the tail is missing.
          const report = await sink.verify();
          expect(report.ok).toBe(false);
          expect(report.breaks[0]?.detail).toContain('closed at 3 events');
        });
      });

      test('an unreadable record is reported rather than thrown', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.append(draft({ capability: 'one' }));

          const key = (await fixture.keys()).find((candidate) => candidate.endsWith('.json'))!;
          await fixture.write(key, new TextEncoder().encode('{ not json'));

          const report = await sink.verify();
          expect(report.ok).toBe(false);
          expect(report.breaks[0]?.kind).toBe('malformed');

          // And a corrupt object must not take a tail down with it.
          expect(await sink.tail()).toEqual([]);
        });
      });

      test('a run that wrote nothing leaves no marker', async () => {
        await use(async (fixture) => {
          const sink = fixture.open({ now: ticking() });
          await sink.close();

          expect(await fixture.keys()).toEqual([]);
        });
      });

      test('two runs over the same store each verify on their own', async () => {
        await use(async (fixture) => {
          const first = fixture.open({ now: ticking(), run: 'r_first' });
          await first.append(draft({ capability: 'one' }));
          await first.close();

          const second = fixture.open({ now: ticking(Date.UTC(2026, 7, 12, 11, 0, 0)) });
          await second.append(draft({ capability: 'two' }));

          const report = await second.verify();
          expect(report.ok).toBe(true);
          expect(report.runs).toBe(2);
          expect(report.events).toBe(2);
        });
      });
    });

    test('the sink exposes no way to mutate or remove an event', async () => {
      await use(async (fixture) => {
        // The append-only guarantee is the absence of these methods, so assert
        // the absence directly rather than trusting the interface to stay
        // honest. `https://lanes.sh/docs/link/security` lists `audit.append-only` as ENFORCED on
        // the grounds that the store interface has no update or delete — this
        // is the check behind that claim, and it holds for every adapter.
        const sink = fixture.open();
        const surface = sink as unknown as Record<string, unknown>;

        expect(Object.keys(sink).sort()).toEqual(['append', 'close', 'tail', 'verify']);
        expect(surface['update']).toBeUndefined();
        expect(surface['delete']).toBeUndefined();
        expect(surface['truncate']).toBeUndefined();
      });
    });
  });
}
