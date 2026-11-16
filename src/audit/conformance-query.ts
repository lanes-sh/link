import { describe, expect, test } from 'bun:test';
import { draft, ticking, type ContractSink } from './conformance-fixtures.ts';

/**
 * What a query answers: which rows come back, and how much of the log they
 * speak for.
 *
 * Its own file because the suite outgrew the budget, and worth being its own
 * *section* because of what was missing from it. Every filter case here used to
 * ask for an unbounded tail, so a store that spent the limit first and narrowed
 * the remainder passed all of them — which is exactly what the read surface was
 * doing one layer up. `a limit counts rows that matched` is the case that
 * closes that, and the budget cases hold the other half: a walk that stops
 * early has to say that it did.
 */
export function describeQueryContract(
  use: (body: (fixture: ContractSink) => Promise<void>) => Promise<void>,
): void {
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

        expect((await sink.tail({ provider: 'drive' })).events.map((e) => e.capability)).toEqual([
          'drive.list',
        ]);
        expect((await sink.tail({ connection: 'drive.main' })).events.map((e) => e.capability)).toEqual([
          'drive.list',
        ]);
        expect((await sink.tail({ capability: 'gmail.list' })).events.map((e) => e.provider)).toEqual([
          'gmail',
        ]);
        expect((await sink.tail({ deniedOnly: true })).events.map((e) => e.capability)).toEqual([
          'vault.get',
        ]);
      });
    });

    test('profiles narrows to the rows that happened in them', async () => {
      await use(async (fixture) => {
        const sink = fixture.open({ now: ticking() });
        await sink.append(draft({ profile: 'personal', capability: 'a' }));
        await sink.append(draft({ profile: 'work', capability: 'b' }));
        await sink.append(draft({ profile: 'personal', capability: 'c' }));

        expect(
          (await sink.tail({ profiles: ['personal'] })).events.map((e) => e.capability),
        ).toEqual(['a', 'c']);
        expect((await sink.tail({ profiles: ['work'] })).events.map((e) => e.capability)).toEqual([
          'b',
        ]);
        expect(
          (await sink.tail({ profiles: ['personal', 'work'] })).events.map((e) => e.capability),
        ).toEqual(['a', 'b', 'c']);
      });
    });

    test('an empty profiles list matches nothing, rather than everything', async () => {
      // The honest answer for a caller asking about a profile they may not
      // reach. Read as "unset" it would hand them the whole workspace's log,
      // which is the failure mode a `?.length` guard introduces.
      await use(async (fixture) => {
        const sink = fixture.open({ now: ticking() });
        await sink.append(draft({ profile: 'personal' }));

        expect((await sink.tail({ profiles: [] })).events).toEqual([]);
      });
    });

    test('a limit counts rows that matched, not rows that were walked', async () => {
      // The assertion this suite was missing. Every filter case above asks
      // for an unbounded tail, so a store that cut to the limit and filtered
      // the remainder passed all of them — and that is exactly what the read
      // surface was doing one layer up: asking for a hundred rows and then
      // narrowing, which returns one profile's share of the newest hundred.
      await use(async (fixture) => {
        const sink = fixture.open({ now: ticking() });
        await sink.append(draft({ profile: 'personal', capability: 'a' }));
        for (let i = 0; i < 5; i += 1) await sink.append(draft({ profile: 'noise' }));
        await sink.append(draft({ profile: 'personal', capability: 'b' }));

        const page = await sink.tail({ profiles: ['personal'], limit: 2 });
        expect(page.events.map((e) => e.capability)).toEqual(['a', 'b']);
      });
    });

    test('since excludes anything older', async () => {
      await use(async (fixture) => {
        const sink = fixture.open({ now: ticking() });
        const first = await sink.append(draft({ capability: 'old' }));
        await sink.append(draft({ capability: 'new' }));

        const after = new Date(first.timestamp.getTime() + 1);
        expect((await sink.tail({ since: after })).events.map((e) => e.capability)).toEqual(['new']);
      });
    });
  });

  describe('the budget', () => {
    test('a walk that stops early says so, and says how far it got', async () => {
      await use(async (fixture) => {
        const sink = fixture.open({ now: ticking() });
        for (let i = 0; i < 10; i += 1) await sink.append(draft({ profile: 'noise' }));

        // Nothing matches, so the walk runs to the budget rather than to the
        // limit. Without `complete` the answer is an empty list, which reads
        // exactly like a profile that never did anything.
        const page = await sink.tail({ profiles: ['absent'], budget: 4 });

        expect(page.events).toEqual([]);
        expect(page.complete).toBe(false);
        expect(page.scanned).toBe(4);
      });
    });

    test('a walk that reaches the end of the log is complete', async () => {
      await use(async (fixture) => {
        const sink = fixture.open({ now: ticking() });
        await sink.append(draft({ profile: 'personal' }));

        const page = await sink.tail({ profiles: ['absent'], budget: 100 });

        expect(page.events).toEqual([]);
        expect(page.complete).toBe(true);
        expect(page.scanned).toBe(1);
      });
    });
  });
}
