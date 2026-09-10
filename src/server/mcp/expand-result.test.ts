import { describe, expect, test } from 'bun:test';
import type { DispatchOutcome } from '#dispatch';
import { expandIfReferences } from './expand-result.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * The gateway half, which had no tests at all when it overflowed a reply.
 *
 * `expand.test.ts` covers the decisions in isolation. What is left — and what
 * the reported failure actually exercised — is the wiring: whether the
 * projection reaches the call, whether the arguments a caller wrote survive it,
 * and whether everything the list returned comes back.
 */

const LIST = 'vendor_mail.messages.list';
const GET = 'vendor_mail.messages.get';

const reachable = (compact?: Record<string, unknown>): Map<string, MergedCapability> =>
  new Map([
    [LIST, {} as MergedCapability],
    [GET, (compact === undefined ? {} : { compact }) as MergedCapability],
  ]);

const listing = (rows: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ messages: rows, ...extra }) }],
});

const references = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, at) => ({ id: `id${at}`, threadId: `t${at}` }));

/** A dispatcher that records what it was asked and answers with a small record. */
function recorder(record: (id: string) => Record<string, unknown> = (id) => ({ id, subject: id })) {
  const calls: { capability: string; args: Record<string, unknown> }[] = [];
  const dispatch = async (
    capability: string,
    args: Record<string, unknown>,
  ): Promise<DispatchOutcome> => {
    calls.push({ capability, args });
    return {
      ok: true,
      result: {
        content: [{ type: 'text' as const, text: JSON.stringify(record(args['id'] as string)) }],
      },
    } as DispatchOutcome;
  };
  return { calls, dispatch };
}

const bodyOf = (filled: { content: { type: 'text'; text: string }[] } | undefined) =>
  JSON.parse((filled?.content[0]?.text ?? '').split('\n\n')[0] ?? '') as Record<string, unknown>;

describe('when it declines to fill anything in', () => {
  /**
   * Each of these must cost nothing. Expanding is somebody else's rate limit,
   * so a path that decides not to must not have already spent one.
   */
  test('a caller who said no is not expanded, and nothing is dispatched', async () => {
    const { calls, dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(3)),
      asked: false,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(filled).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a list with no get beside it is left alone', async () => {
    const { calls, dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(3)),
      asked: undefined,
      merged: new Map([[LIST, {} as MergedCapability]]),
      listArguments: {},
      dispatch,
    });

    expect(filled).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('rows that are already records are left alone', async () => {
    const { calls, dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing([{ id: 'a', subject: 'Standup', when: 'today' }]),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(filled).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('prose is not a result to expand', async () => {
    const { calls, dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: { content: [{ type: 'text' as const, text: 'Deleted 3 messages.' }] },
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(filled).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('asking the provider for a smaller record', () => {
  /**
   * The fix, in one assertion. Without this the follow-up goes out with the
   * caller's arguments alone and comes back at whatever the vendor defaults to,
   * which is what made five rows 193,271 characters.
   */
  test('the projection the provider declared reaches the follow-up', async () => {
    const { calls, dispatch } = recorder();

    await expandIfReferences({
      capability: LIST,
      result: listing(references(2)),
      asked: undefined,
      merged: reachable({ view: 'summary' }),
      listArguments: {},
      dispatch,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.capability).toBe(GET);
    expect(calls[0]?.args).toEqual({ view: 'summary', id: 'id0' });
  });

  test('whole records are asked for by sending no projection at all', async () => {
    const { calls, dispatch } = recorder();

    await expandIfReferences({
      capability: LIST,
      result: listing(references(1)),
      asked: 'full',
      merged: reachable({ view: 'summary' }),
      listArguments: {},
      dispatch,
    });

    expect(calls[0]?.args).toEqual({ id: 'id0' });
  });

  test('a provider that declared nothing still expands', async () => {
    const { calls, dispatch } = recorder();

    await expandIfReferences({
      capability: LIST,
      result: listing(references(1)),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(calls[0]?.args).toEqual({ id: 'id0' });
  });

  /**
   * The list's own arguments are inherited so a `userId` reaches the get, the
   * projection wins over them, and the identifier wins over everything — it is
   * the one argument that is not a preference.
   */
  test('the list arguments are inherited, the projection beats them, and the id beats both', async () => {
    const { calls, dispatch } = recorder();

    await expandIfReferences({
      capability: LIST,
      result: listing(references(1)),
      asked: undefined,
      merged: reachable({ view: 'summary' }),
      listArguments: { userId: 'me', view: 'everything', id: 'ignored' },
      dispatch,
    });

    expect(calls[0]?.args).toEqual({ userId: 'me', view: 'summary', id: 'id0' });
  });
});

describe('what comes back', () => {
  /** The client's acceptance criterion: all of them, at the smaller shape. */
  test('every row the list returned is present', async () => {
    const { dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(20)),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(bodyOf(filled)['messages']).toHaveLength(20);
  });

  /**
   * The rows that did not fit come back exactly as the vendor wrote them. The
   * old code replaced the array with the ones it had filled, so the note telling
   * a caller to fetch the rest named identifiers it had just thrown away.
   */
  test('rows that did not fit survive as the references they were', async () => {
    const heavy = 'x'.repeat(12 * 1024);
    const { dispatch } = recorder((id) => ({ id, body: heavy }));

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(20)),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    const rows = bodyOf(filled)['messages'] as Record<string, unknown>[];
    expect(rows).toHaveLength(20);
    expect(rows[19]).toEqual({ id: 'id19', threadId: 't19' });
    expect(filled?.content[0]?.text).toContain('came back as identifiers only');
    expect(filled?.content[0]?.text).toContain(GET);
  });

  /** Paging was impossible while the fill discarded everything beside the array. */
  test("the vendor's own page token survives the fill", async () => {
    const { dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(2), { nextPageToken: 'page-2', resultSizeEstimate: 40 }),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(bodyOf(filled)['nextPageToken']).toBe('page-2');
    expect(bodyOf(filled)['resultSizeEstimate']).toBe(40);
  });

  test('a reply with nothing left over says nothing about rows left over', async () => {
    const { dispatch } = recorder();

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(3)),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    expect(filled?.content[0]?.text).not.toContain('identifiers only');
  });

  /** A follow-up failing is not the list call failing. */
  test('a follow-up that fails leaves its reference and counts as unfilled', async () => {
    const dispatch = async (_capability: string, args: Record<string, unknown>) =>
      (args['id'] === 'id0'
        ? { ok: false, authorization: 'denied_by_policy', message: 'no' }
        : {
            ok: true,
            result: { content: [{ type: 'text' as const, text: JSON.stringify({ id: args['id'] }) }] },
          }) as DispatchOutcome;

    const filled = await expandIfReferences({
      capability: LIST,
      result: listing(references(2)),
      asked: undefined,
      merged: reachable(),
      listArguments: {},
      dispatch,
    });

    const rows = bodyOf(filled)['messages'] as Record<string, unknown>[];
    expect(rows[0]).toEqual({ id: 'id0', threadId: 't0' });
    expect(rows[1]).toEqual({ id: 'id1' });
    expect(filled?.content[0]?.text).toContain('1 further row came back as identifiers only');
  });
});
