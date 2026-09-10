import { describe, expect, test } from 'bun:test';
import { expandMode, fill, noteFor, referencesIn, sibling } from './expand.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * Filling in a list that came back as references.
 *
 * Most of this file is about when it does *not* fire, and that is the point.
 * Expanding without being asked spends the owner's rate limit on an inference,
 * which is exactly why Stripe and OData make the caller request it. The trade
 * is only defensible if a false positive is close to impossible, so the tests
 * that matter are the ones asserting a list is left alone.
 */

const reachable = (ids: readonly string[]): Map<string, MergedCapability> =>
  new Map(ids.map((id) => [id, {} as MergedCapability]));

describe('finding the capability that resolves a reference', () => {
  test('a list pairs with the get beside it', () => {
    const merged = reachable(['vendor_mail.messages.list', 'vendor_mail.messages.get']);

    expect(sibling('vendor_mail.messages.list', merged)).toBe('vendor_mail.messages.get');
  });

  /** A provider that does not follow the convention simply never pairs. */
  test('a list with no get beside it pairs with nothing', () => {
    const merged = reachable(['vendor_mail.messages.list']);

    expect(sibling('vendor_mail.messages.list', merged)).toBeUndefined();
  });

  /**
   * Reachability is the test, not existence. A `get` this caller may not use is
   * not a `get` as far as this is concerned, so policy cannot be walked around
   * by way of a list that is allowed.
   */
  test('a get the caller cannot reach does not count', () => {
    const merged = reachable(['vendor_mail.messages.list', 'vendor_mail.other.get']);

    expect(sibling('vendor_mail.messages.list', merged)).toBeUndefined();
  });

  test('anything that is not a list pairs with nothing', () => {
    const merged = reachable(['vendor_mail.messages.get', 'vendor_mail.send_message']);

    expect(sibling('vendor_mail.send_message', merged)).toBeUndefined();
  });
});

describe('deciding whether a result is references', () => {
  test('rows carrying nothing but identifiers are references', () => {
    const body = JSON.stringify({
      messages: [
        { id: 'a1', threadId: 't1' },
        { id: 'a2', threadId: 't2' },
      ],
      nextPageToken: 'x',
    });

    expect(referencesIn(body)).toEqual({
      at: 'messages',
      rows: [
        { id: 'a1', threadId: 't1' },
        { id: 'a2', threadId: 't2' },
      ],
      body: {
        messages: [
          { id: 'a1', threadId: 't1' },
          { id: 'a2', threadId: 't2' },
        ],
        nextPageToken: 'x',
      },
    });
  });

  /**
   * The case that must not fire. A row with a subject and a date is the record
   * already — fetching it again would be a second call for something the caller
   * is holding.
   */
  test('rows that are already the record are left alone', () => {
    const body = JSON.stringify({
      events: [{ id: 'e1', summary: 'Standup', start: '2026-01-01T09:00:00Z' }],
    });

    expect(referencesIn(body)).toBeUndefined();
  });

  test('a row with no identifier is not a reference', () => {
    expect(referencesIn(JSON.stringify({ rows: [{ threadId: 't1' }] }))).toBeUndefined();
  });

  /**
   * Two arrays means the shape is not "a list of things" and guessing which one
   * was meant is exactly the kind of inference this must not make.
   */
  test('a body with two lists in it is ambiguous and left alone', () => {
    const body = JSON.stringify({ messages: [{ id: 'a' }], drafts: [{ id: 'b' }] });

    expect(referencesIn(body)).toBeUndefined();
  });

  test('an empty list has nothing to fill in', () => {
    expect(referencesIn(JSON.stringify({ messages: [] }))).toBeUndefined();
  });

  test('prose is not a result to expand', () => {
    expect(referencesIn('Deleted 3 messages.')).toBeUndefined();
    expect(referencesIn('')).toBeUndefined();
  });

  test('a bare array is not the shape either', () => {
    expect(referencesIn(JSON.stringify([{ id: 'a' }]))).toBeUndefined();
  });
});

describe('doing the follow-ups', () => {
  const references = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, at) => ({ id: `id${at}`, threadId: `t${at}` }));

  test('each reference becomes the record it names', async () => {
    const { rows, fetched } = await fill(references(2), async (id) =>
      JSON.stringify({ id, subject: `re: ${id}` }),
    );

    expect(fetched).toBe(2);
    expect(rows).toEqual([
      { id: 'id0', subject: 're: id0' },
      { id: 'id1', subject: 're: id1' },
    ]);
  });

  /**
   * The whole point of the rewrite. A page of small records is a page, not five
   * of them, because what a reply costs is bytes and five was a count.
   */
  test('a page of compact rows is filled in completely', async () => {
    const { rows, fetched } = await fill(references(20), async (id) => JSON.stringify({ id }));

    expect(fetched).toBe(20);
    expect(rows).toHaveLength(20);
    // Every row is the record, not the reference it started as.
    expect(rows.every((row) => !('threadId' in (row as Record<string, unknown>)))).toBe(true);
  });

  /**
   * The reported failure, in one test. Records this large are what turned a
   * question about an inbox into 193,271 characters, and the budget is what
   * stops it — but every row still comes back, which is what the note that
   * mentions them is now able to assume.
   */
  test('records too large to all fit stop at the budget, and the rest survive as references', async () => {
    const heavy = 'x'.repeat(12 * 1024);
    const { rows, fetched } = await fill(references(20), async (id) =>
      JSON.stringify({ id, body: heavy }),
    );

    expect(fetched).toBeLessThan(20);
    expect(rows).toHaveLength(20);
    expect(rows[19]).toEqual({ id: 'id19', threadId: 't19' });
  });

  /**
   * `FEWEST`, and the reason the first row is fetched on its own: a record big
   * enough to spend the whole budget has to be seen to be measured, and a first
   * wave of three would have paid for three of them to find that out.
   */
  test('a single record larger than the whole budget is still filled in, and costs one call', async () => {
    const asked: string[] = [];
    const { rows, fetched } = await fill(references(6), async (id) => {
      asked.push(id);
      return JSON.stringify({ id, body: 'x'.repeat(64 * 1024) });
    });

    expect(asked).toEqual(['id0']);
    expect(fetched).toBe(1);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({ id: 'id1', threadId: 't1' });
  });

  /** Somebody else's quota, not the caller's context — the other bound. */
  test('a very long list stops at the fan-out ceiling', async () => {
    const asked: string[] = [];
    const { rows, fetched } = await fill(references(200), async (id) => {
      asked.push(id);
      return JSON.stringify({ id });
    });

    expect(asked.length).toBeLessThanOrEqual(25);
    expect(fetched).toBe(asked.length);
    expect(rows).toHaveLength(200);
  });

  /**
   * One row failing must not fail the call that found it. The reference is
   * returned exactly as it arrived — `threadId` and all — so a caller told to
   * fetch it by hand is holding what that takes.
   */
  test('a follow-up that fails leaves its reference behind, verbatim', async () => {
    const { rows, fetched } = await fill(references(2), async (id) =>
      id === 'id0' ? undefined : JSON.stringify({ id, subject: 'ok' }),
    );

    expect(fetched).toBe(1);
    expect(rows[0]).toEqual({ id: 'id0', threadId: 't0' });
    expect(rows[1]).toEqual({ id: 'id1', subject: 'ok' });
  });

  test('order is the order the list gave, not the order they arrived', async () => {
    const { rows } = await fill(references(4), async (id) => {
      await new Promise((resolve) => setTimeout(resolve, id === 'id0' ? 20 : 1));
      return JSON.stringify({ id });
    });

    expect(rows).toEqual([{ id: 'id0' }, { id: 'id1' }, { id: 'id2' }, { id: 'id3' }]);
  });
});

describe('which representation to fill in with', () => {
  test('nothing said means the small one', () => {
    expect(expandMode(undefined)).toBe('compact');
    expect(expandMode('compact')).toBe('compact');
  });

  test('whole records are asked for by name', () => {
    expect(expandMode('full')).toBe('full');
  });

  test('false declines', () => {
    expect(expandMode(false)).toBeUndefined();
  });

  /**
   * Accepted and never advertised. `expand` shipped as a boolean, and ADR-032 is
   * the record that a client which pinned its tool list at registration serves
   * that schema forever — so refusing `true` would break exactly the clients the
   * stable-name pair exists to rescue.
   */
  test('the boolean this shipped as still means what it meant', () => {
    expect(expandMode(true)).toBe('compact');
  });
});

describe('saying what is still an identifier', () => {
  test('nothing left means nothing to say', () => {
    expect(noteFor('compact', 'vendor_mail.messages.get', 0)).toBe('');
  });

  /** Naming it saves the caller a search for the thing it was just told to call. */
  test('the note names the capability that resolves one', () => {
    expect(noteFor('compact', 'vendor_mail.messages.get', 2)).toContain(
      'vendor_mail.messages.get',
    );
    expect(noteFor('compact', 'vendor_mail.messages.get', 2)).toContain('2 further rows');
  });

  test('one row left is said in the singular', () => {
    expect(noteFor('compact', 'vendor_mail.messages.get', 1)).toContain('1 further row came');
  });

  /**
   * Under `full` the better answer is usually to ask for less, so the note says
   * so. Under `compact` there is no smaller mode to point at.
   */
  test('asking for whole records is told there is a smaller way', () => {
    expect(noteFor('full', 'vendor_mail.messages.get', 3)).toContain('expand: "compact"');
    expect(noteFor('compact', 'vendor_mail.messages.get', 3)).not.toContain('expand:');
  });
});
