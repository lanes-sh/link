import { describe, expect, test } from 'bun:test';
import { fill, referencesIn, sibling } from './expand.ts';
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

    expect(referencesIn(body)).toEqual({ at: 'messages', ids: ['a1', 'a2'] });
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
  test('each reference becomes the record it names', async () => {
    const { filled, capped } = await fill(['a', 'b'], async (id) =>
      JSON.stringify({ id, subject: `re: ${id}` }),
    );

    expect(capped).toBe(0);
    expect(filled).toEqual([
      { id: 'a', subject: 're: a' },
      { id: 'b', subject: 're: b' },
    ]);
  });

  /**
   * Bounded, and it says so. A silent truncation reads as "that is all there
   * was", which is the failure mode worth more than the rows it saves.
   */
  test('a long list is capped, and the remainder is reported', async () => {
    const many = Array.from({ length: 12 }, (_, at) => `id${at}`);
    const { filled, capped } = await fill(many, async (id) => JSON.stringify({ id }));

    expect(filled).toHaveLength(5);
    expect(capped).toBe(7);
  });

  /**
   * One row failing must not fail the call that found it. The reference is
   * returned as it arrived, which is no worse than not having expanded at all.
   */
  test('a follow-up that fails leaves its reference behind', async () => {
    const { filled } = await fill(['a', 'b'], async (id) =>
      id === 'a' ? undefined : JSON.stringify({ id, subject: 'ok' }),
    );

    expect(filled[0]).toEqual({ id: 'a' });
    expect(filled[1]).toEqual({ id: 'b', subject: 'ok' });
  });

  test('order is the order the list gave, not the order they arrived', async () => {
    const { filled } = await fill(['a', 'b', 'c', 'd'], async (id) => {
      await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 20 : 1));
      return JSON.stringify({ id });
    });

    expect(filled).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  });
});
