import { describe, expect, test } from 'bun:test';
import { searchCapabilities } from './search-index.ts';
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
  options: { title?: string; properties?: Record<string, unknown> } = {},
): MergedCapability {
  return {
    reachable: new Map([['personal', ['vendor_mail.main']]]),
    capability: undefined,
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
  ['vendor_mail.messages.list', entry('List the messages in a mailbox.')],
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
   */
  test('a query naming a provider reaches that provider', () => {
    const answer = searchCapabilities('vendor_chat', surface);
    const first = answer.indexOf('vendor_chat_post_message');

    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(answer.indexOf('vendor_mail_messages_list'));
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
