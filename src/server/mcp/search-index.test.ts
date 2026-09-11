import { describe, expect, test } from 'bun:test';
import { searchCapabilities, searchResults } from './search-index.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * What the search says, given a set of capabilities.
 *
 * A pure function of the merged map, which is why it is tested here rather than
 * through an endpoint: what is worth asserting is the ranking and what comes
 * back with a schema, and neither needs a server to be wrong.
 */

/** One discovered capability, of the shape an `http` provider yields. */
function entry(
  description: string,
  options: { title?: string; properties?: Record<string, unknown>; reads?: boolean } = {},
): MergedCapability {
  return {
    reachable: new Map([['personal', ['vendor_mail.main']]]),
    capability: undefined,
    // What the connector assigned, as `mergeCapabilities` resolves it — from the
    // request method for an `http` provider. Written out per entry because the
    // read-only filter narrows on this and never on the id.
    reads: options.reads ?? false,
    discovered: {
      name: 'ignored',
      ...(options.title === undefined ? {} : { title: options.title }),
      description,
      inputSchema: {
        type: 'object',
        properties: options.properties ?? { to: { type: 'string' } },
      },
    },
  } as unknown as MergedCapability;
}

const surface = new Map<string, MergedCapability>([
  [
    'vendor_mail.send_message',
    entry('Send a message to one or more recipients.', {
      title: 'Vendor Mail: send message',
      properties: { to: { type: 'string' }, subject: { type: 'string' } },
    }),
  ],
  ['vendor_mail.messages.list', entry('List the messages in a mailbox.', { reads: true })],
  ['vendor_sheets.values.update', entry('Set values in a range of a spreadsheet.')],
  ['vendor_chat.post_message', entry('Post a message to a channel.')],
]);

describe('searching what a caller can reach', () => {
  test('a keyword reaches the capability that answers to it', () => {
    const answer = searchCapabilities('spreadsheet', surface);

    expect(answer).toContain('vendor_sheets_values_update');
    expect(answer).not.toContain('vendor_chat_post_message');
  });

  /**
   * The provider id is in the capability id and nowhere else, and it is what a
   * query naming a vendor has to match on. Weighted highest for that reason.
   *
   * And narrowed to it: `vendor_chat` splits to `vendor` + `chat`, and every
   * capability here carries `vendor`, so scoring on any term would return the
   * whole surface with the right one merely on top. Requiring both is what
   * makes the answer this provider rather than this provider first.
   */
  test('a query naming a provider reaches that provider and not its neighbours', () => {
    const answer = searchCapabilities('vendor_chat', surface);

    expect(answer).toContain('vendor_chat_post_message');
    expect(answer).not.toContain('vendor_mail_messages_list');
    expect(answer).not.toContain('vendor_sheets_values_update');
  });

  /**
   * The fallback, and why the narrowing above is safe. A caller whose words do
   * not all appear anywhere is exactly the caller who needs the near misses —
   * returning nothing there would be worse than returning the loose ranking.
   */
  test('falls back to a loose match when no capability has every term', () => {
    const answer = searchCapabilities('spreadsheet cryptocurrency', surface);

    expect(answer).toContain('vendor_sheets_values_update');
    expect(answer).not.toContain('Nothing reachable matches');
  });

  /**
   * The second call a model makes after a search is "what are the arguments for
   * this one", and that should not be a search.
   */
  test('an exact capability id returns that one, with its schema', () => {
    const answer = searchCapabilities('vendor_mail.send_message', surface);

    expect(answer).toContain('1 match');
    expect(answer).toContain('vendor_mail_send_message');
    expect(answer).toContain('"subject"');
    expect(answer).not.toContain('vendor_chat');
  });

  /**
   * The whole reason the search returns schemas: the accuracy gain that makes
   * deferred tool loading worth doing is attributed to the model seeing a real
   * schema before it composes arguments (ADR-075). A search returning only
   * names would keep the saving and give up the reason.
   */
  test('a match carries its input schema, not just its name', () => {
    const answer = searchCapabilities('send message recipients', surface);

    expect(answer).toContain('JSON Schema');
    expect(answer).toContain('"to"');
  });

  /**
   * Both ways in, and which to prefer. This is the answer to #162's objection
   * that a model seeing two paths picks the wrong one — it is told which path
   * it is on, by the only party that can see its tool list.
   */
  test('every answer says to prefer the named tool and when not to', () => {
    const answer = searchCapabilities('message', surface);

    expect(answer).toContain('Prefer the named tool if your tool list has it');
    expect(answer).toContain('lanes_tools_call');
  });

  /**
   * A miss has to say which kind of miss it is. The caller cannot distinguish
   * "no such provider" from "not connected" from "not granted", and guessing
   * wrong sends them to reconnect something that was denied on purpose.
   */
  test('a miss says it searched what is reachable, and where to look next', () => {
    const answer = searchCapabilities('cryptocurrency', surface);

    expect(answer).toContain('Nothing reachable matches');
    expect(answer).toContain('not connected or not granted');
    expect(answer).toContain('lanes_setup_overview');
  });

  /**
   * `describeWithConnections` appends the same block to every description, so
   * searching it would match its every word against everything — "profile" or
   * an account's domain would return the whole surface.
   */
  test('the connections block appended to every description is not searched', () => {
    const withBlock = new Map<string, MergedCapability>([
      [
        'vendor_mail.send_message',
        entry(
          'Send a message.\n\nAvailable connections, by profile:\n  personal:\n    vendor_mail.main — someone@example.com',
        ),
      ],
    ]);

    expect(searchCapabilities('personal', withBlock)).toContain('Nothing reachable matches');
    expect(searchCapabilities('send', withBlock)).toContain('vendor_mail_send_message');
  });

  /**
   * The narrowing makes a query's grammar load-bearing, so the grammar has to
   * be dropped. Measured on a real endpoint: "send an email" asked for `an` as
   * a whole word, nothing had it alongside the other two, and the query fell
   * back to the loose ranking it was meant to replace — 93 matches of 276.
   */
  test('function words in a query do not narrow it', () => {
    const plain = searchCapabilities('send message', surface);
    const spoken = searchCapabilities('please send a message to me', surface);

    expect(spoken).toContain('vendor_mail_send_message');
    // The same matches either way, which is the whole claim. Compared as the
    // set of results rather than the count line, so the assertion says what it
    // means rather than depending on how the count is phrased.
    const named = (answer: string) =>
      answer
        .split('\n')
        .filter((line) => line.startsWith('## '))
        .map((line) => line.slice(3));

    expect(named(spoken)).toEqual(named(plain));
  });

  /**
   * A query that is nothing but function words searches for them rather than
   * for nothing, because the alternative is an empty-query answer to a caller
   * who did type something.
   */
  test('a query of only function words still searches', () => {
    expect(searchCapabilities('the a of', surface)).not.toContain('Nothing reachable matches');
  });

  test('an empty query matches nothing rather than everything', () => {
    expect(searchCapabilities('   ', surface)).toContain('Nothing reachable matches');
  });

  /** Where a capability can be used is what the caller needs to fill in `connection`. */
  test('a match says which profiles and connections reach it', () => {
    expect(searchCapabilities('vendor_mail.send_message', surface)).toContain(
      'personal: vendor_mail.main',
    );
  });
});

/**
 * What an answer promises, beyond naming the right capability.
 *
 * The ranking work made the first result right. These are the properties that
 * decide whether being right is *enough* — whether the caller can act on the
 * answer, or has to come back and ask again.
 */
describe('what comes back', () => {
  /**
   * The line that cost a round trip.
   *
   * Twenty ids used to follow the explained matches under "Search again with a
   * capability id for one of these to get its arguments" — an instruction to
   * spend another turn, printed once per id. On the endpoint this work started
   * from, the capability that reads a mailbox was in that tail.
   */
  test('nothing is listed without the arguments needed to call it', () => {
    const answer = searchCapabilities('message', surface);

    expect(answer).not.toContain('Search again');
    expect(answer).not.toContain('without schemas');
    for (const line of answer.split('\n')) expect(line).not.toMatch(/^- `[^`]+` —/);
  });

  /** Every capability named in an answer arrives with a schema attached. */
  test('every capability named is one the caller could invoke', () => {
    const answer = searchCapabilities('message', surface);
    const named = (answer.match(/^capability: /gm) ?? []).length;
    const schemas = (answer.match(/^arguments \(JSON Schema/gm) ?? []).length;

    expect(named).toBeGreaterThan(0);
    expect(schemas).toBe(named);
  });

  /** A residue is counted, so the caller knows to narrow rather than to re-ask. */
  test('matches beyond the limit are counted, not enumerated', () => {
    const answer = searchCapabilities('message', surface, undefined, { limit: 1 });

    expect((answer.match(/^capability: /gm) ?? []).length).toBe(1);
    expect(answer).toMatch(/further match(es)? scored lower/);
  });

  test('a provider filter narrows to that provider', () => {
    const answer = searchCapabilities('message', surface, undefined, { provider: 'vendor_chat' });

    expect(answer).toContain('vendor_chat.post_message');
    expect(answer).not.toContain('vendor_mail.messages.list');
  });

  /**
   * A behaviour filter, and only that. It narrows the answer; it cannot make a
   * write reachable or unreachable, which is policy's job and stays there.
   */
  test('a read-only filter withholds the writes', () => {
    const answer = searchCapabilities('message', surface, undefined, { readOnly: true });

    expect(answer).toContain('vendor_mail.messages.list');
    expect(answer).not.toContain('vendor_chat.post_message');
  });

  /**
   * The two answers to "does this only read" disagree, and the filter has to
   * take the provider's.
   *
   * A report run over POST is a read the name cannot show, and a get-or-create
   * is a write whose name opens with `get`. Reading either off the id inverts
   * both: the caller asking to be shown only safe operations would be handed the
   * one that writes and denied the one that does not.
   */
  test('a read-only filter takes the provider\'s answer over the name', () => {
    const reports = new Map<string, MergedCapability>([
      [
        'vendor_reports.run_report',
        entry('Run a saved report and return its rows.', { reads: true }),
      ],
      [
        'vendor_reports.get_or_create_report',
        entry('Fetch a report by name, creating it if it does not exist.', { reads: false }),
      ],
    ]);

    const answer = searchCapabilities('report', reports, undefined, { readOnly: true });

    expect(answer).toContain('vendor_reports.run_report');
    expect(answer).not.toContain('vendor_reports.get_or_create_report');
  });

  /**
   * Under `surface: crunched` there is no typed tool to carry `readOnlyHint`, so
   * a search result is the only place a client can learn a call is safe.
   */
  test('a match says whether it only reads', () => {
    const { capabilities } = searchResults('mailbox', surface);

    expect(capabilities[0]?.capability).toBe('vendor_mail.messages.list');
    expect(capabilities[0]?.reads).toBe(true);
    expect(searchCapabilities('mailbox', surface)).toContain('read-only:  yes');
  });

  test('a write is not described as read-only', () => {
    const { capabilities } = searchResults('spreadsheet', surface);

    expect(capabilities[0]?.reads).toBe(false);
    expect(searchCapabilities('spreadsheet', surface)).not.toContain('read-only');
  });

  test('the structured copy carries what the prose says', () => {
    const { matched, capabilities } = searchResults('spreadsheet', surface);

    expect(matched).toBeGreaterThan(0);
    expect(capabilities[0]?.capability).toBe('vendor_sheets.values.update');
    expect(capabilities[0]?.inputSchema).toHaveProperty('properties');
    expect(capabilities[0]?.reachable[0]?.profile).toBe('personal');
  });
});

/**
 * What an answer says about where a call can go.
 *
 * Every routing argument this endpoint takes is a profile and a connection, and
 * a caller holding a capability id still has to find both before it can use
 * one. That was its own round trip: on the exchange this work began with,
 * `lanes_setup_overview` was the second of seven calls, asked before the search
 * that found anything.
 *
 * It is a short, fixed list the search already knows, so it goes at the top of
 * every answer — including the answer that found nothing, which is exactly when
 * a caller most needs to know what *is* reachable.
 */
describe('the accounts an answer names', () => {
  const accounts = new Map([
    ['personal', new Map([['vendor_mail.main', 'ada.lovelace@example.com']])],
    ['work', new Map([['vendor_chat.team', 'ada-lovelace']])],
  ]);

  test('every profile and account is named above the matches', () => {
    const answer = searchCapabilities('spreadsheet', surface, undefined, {}, accounts);

    expect(answer).toContain('Reachable from here');
    expect(answer).toContain('personal');
    expect(answer).toContain('vendor_mail.main — ada.lovelace@example.com');
    expect(answer).toContain('work');
    expect(answer).toContain('vendor_chat.team — ada-lovelace');
    // Above the matches, so a caller reading top-down has the routing before
    // the thing being routed.
    expect(answer.indexOf('Reachable from here')).toBeLessThan(answer.indexOf('capability:'));
  });

  test('a miss names them too, which is when it matters most', () => {
    const answer = searchCapabilities('nothing here at all', surface, undefined, {}, accounts);

    expect(answer).toContain('Nothing reachable matches');
    expect(answer).toContain('vendor_mail.main — ada.lovelace@example.com');
  });

  test('an endpoint with nothing connected says nothing rather than an empty box', () => {
    expect(searchCapabilities('spreadsheet', surface, undefined, {}, new Map())).not.toContain(
      'Reachable from here',
    );
  });

  test('the structured copy carries the same list', () => {
    const { reachable } = searchResults('spreadsheet', surface, {}, accounts);

    expect(reachable).toEqual([
      { profile: 'personal', connections: [{ connection: 'vendor_mail.main', account: 'ada.lovelace@example.com' }] },
      { profile: 'work', connections: [{ connection: 'vendor_chat.team', account: 'ada-lovelace' }] },
    ]);
  });
});
