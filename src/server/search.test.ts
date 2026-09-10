import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineLocalProvider } from '#connectivity';
import { allocatePort, parseConfig, rpc, startHarness } from './harness.ts';
import { SURFACE_TOOL_NAMES } from './mcp/index.ts';

/**
 * `lanes_tools_search` and `lanes_tools_call`, against a real endpoint.
 *
 * The claim worth proving is the one a reviewer should be most suspicious of: a
 * tool that can invoke any capability by name, added to a surface whose whole
 * design is that discovery and enforcement share one answer (ADR-003, ADR-058).
 * So most of this file is about what `lanes_tools_call` *cannot* do.
 *
 * It widens nothing because it resolves through the same merged capability set
 * the typed tools were registered from, and dispatches through the same
 * `dispatcher.invoke` with the same principal. Every refusal below is therefore
 * the refusal a typed tool would have made — asserted here because "the same
 * code path" is a claim about code, and this is the claim about behaviour.
 */

/** personal: everything on the example provider except one capability, denied. */
const personal = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"
  deny:
    - "example.list_notes"`,
});

/** work: read-only, and a different token. */
const work = startHarness({
  profile: 'work',
  port: allocatePort(),
  token: 'llk_work_token_value',
  policy: `  allow:
    - "example.get_note"
    - "example.list_notes"`,
});

/**
 * A provider shaped like the one that overflowed a reply: a list that answers
 * with bare references, and a get beside it whose record can be made any size.
 *
 * `example` cannot stand in for it — `list_notes` and `get_note` do not pair,
 * because pairing is `<x>.list` with `<x>.get` and nothing else.
 */
const fixtureMail = defineLocalProvider({
  id: 'fixture_mail',
  name: 'Fixture Mail',
  description: 'A list of references and the get that resolves one.',
  configSchema: z.object({}),
  connectionSchema: z.object({}),
  bundles: [
    { name: 'read', description: 'Read.', oauth_scopes: [], capabilities: ['notes.list', 'notes.get'], default: true },
  ],
  capabilities: [
    {
      kind: 'tool',
      name: 'notes.list',
      title: 'List notes',
      description: 'Identifiers of the notes in this account, and a token for the next page.',
      inputSchema: z.object({ count: z.number().optional(), bytes: z.number().optional() }),
      async handler({ count }) {
        const notes = Array.from({ length: count ?? 20 }, (_, at) => ({
          id: `n${at}`,
          threadId: `t${at}`,
        }));
        return {
          content: [
            { type: 'text', text: JSON.stringify({ notes, nextPageToken: 'page-2' }) },
          ],
        };
      },
    },
    {
      kind: 'tool',
      name: 'notes.get',
      title: 'Get a note',
      description: 'One note, by identifier.',
      inputSchema: z.object({ id: z.string(), bytes: z.number().optional() }),
      async handler({ id, bytes }) {
        const note = { id, subject: `re: ${id}`, ...(bytes ? { body: 'x'.repeat(bytes) } : {}) };
        return { content: [{ type: 'text', text: JSON.stringify(note) }] };
      },
    },
  ],
});

/** An endpoint serving it, so expansion can be watched end to end. */
const mailPort = allocatePort();
const mail = startHarness({
  profile: 'personal',
  port: mailPort,
  providers: [fixtureMail],
  // Required by the options type, and unused: `config` replaces what it builds.
  policy: '',
  // Written out rather than taken from `policy`, which grants the two `example`
  // connections the harness always makes and cannot name another provider.
  config: parseConfig(`
contract: 5
instance:
  profile: personal
  port: ${mailPort}
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
grants:
  - connection: fixture_mail.main
    allow:
      - "fixture_mail.*"
members: []
`).config,
});

afterAll(async () => {
  await Promise.all([personal.stop(), work.stop(), mail.stop()]);
});

async function names(url: string, token?: string): Promise<string[]> {
  const response = await rpc(url, 'tools/list', {}, token ? { token } : {});
  const tools = (response.body['result'] as { tools?: { name: string }[] })?.tools ?? [];
  return tools.map((tool) => tool.name);
}

async function call(
  url: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<{ text: string; isError: boolean }> {
  const response = await rpc(
    url,
    'tools/call',
    { name: 'lanes_tools_call', arguments: args },
    token ? { token } : {},
  );
  const result = response.body['result'] as
    | { content?: { text?: string }[]; isError?: boolean }
    | undefined;

  return {
    text: (result?.content ?? []).map((block) => block.text ?? '').join('\n'),
    isError: result?.isError === true,
  };
}

async function search(url: string, query: string, token?: string): Promise<string> {
  const response = await rpc(
    url,
    'tools/call',
    { name: 'lanes_tools_search', arguments: { query } },
    token ? { token } : {},
  );
  const result = response.body['result'] as { content?: { text?: string }[] } | undefined;
  return (result?.content ?? []).map((block) => block.text ?? '').join('\n');
}

describe('the stable-name pair', () => {
  test('is advertised to every caller', async () => {
    for (const name of SURFACE_TOOL_NAMES) {
      expect(await names(personal.server.url)).toContain(name);
      expect(await names(work.server.url, 'llk_work_token_value')).toContain(name);
    }
  });

  test('invokes a capability and returns what it returned', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'example.echo',
      profile: 'personal',
      connection: 'example.a',
      arguments: { message: 'through the dispatcher' },
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('through the dispatcher');
    // The connection the call was routed to, which is what `echo` prefixes —
    // so this also asserts the routing arguments were honoured rather than
    // ignored.
    expect(outcome.text).toContain('example.a');
  });

  test('search finds a reachable capability and gives its arguments', async () => {
    const answer = await search(personal.server.url, 'echo');

    expect(answer).toContain('example_echo');
    expect(answer).toContain('capability: example.echo');
    expect(answer).toContain('"message"');
  });
});

describe('what it cannot do', () => {
  /**
   * The load-bearing one. `example.list_notes` is denied for this profile, so
   * it was never advertised — and a generic dispatcher must not be the way
   * around that. Denied and never-existed are deliberately indistinguishable
   * from here, which is ADR-007's "probing must not be an oracle".
   */
  test('cannot reach a capability policy denied', async () => {
    expect(await names(personal.server.url)).not.toContain('example_list_notes');

    const outcome = await call(personal.server.url, {
      capability: 'example.list_notes',
      profile: 'personal',
      connection: 'example.a',
      arguments: {},
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('cannot reach');
    // Says nothing about why, and nothing about it existing.
    expect(outcome.text).not.toContain('denied');
  });

  /** The same, from the other direction: a narrower profile stays narrower. */
  test('cannot reach a capability a narrower profile was not granted', async () => {
    const outcome = await call(
      work.server.url,
      {
        capability: 'example.set_note',
        profile: 'work',
        connection: 'example.a',
        arguments: { key: 'k', value: 'v' },
      },
      'llk_work_token_value',
    );

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('cannot reach');
  });

  /**
   * Searching the denied id by name does not surface it. It is not an exact
   * match either — an exact match requires the capability to be in the merged
   * set — so the query falls through to keyword ranking and returns this
   * provider's *other* capabilities, which is the right answer: the caller
   * asked about something in this neighbourhood and gets what it may actually
   * reach, with no evidence that the one it named exists.
   */
  test('and the search does not surface it, by id or by keyword', async () => {
    for (const query of ['example.list_notes', 'list notes']) {
      const answer = await search(personal.server.url, query);
      expect(answer).not.toContain('example_list_notes');
      expect(answer).not.toContain('capability: example.list_notes');
    }
  });

  /**
   * The refusal `makeHandler` makes, made here too. The `profile` enum is a
   * union across profiles, so a caller can name a valid profile and a
   * connection belonging to another — and routing one profile's account through
   * another crosses exactly the boundary profiles exist to hold.
   */
  test('refuses a connection that is not part of the named profile', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'example.echo',
      profile: 'personal',
      connection: 'example.not_this_one',
      arguments: { message: 'hello' },
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('is not part of profile');
  });

  test('refuses a profile this caller cannot reach', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'example.echo',
      profile: 'work',
      connection: 'example.a',
      arguments: { message: 'hello' },
    });

    expect(outcome.isError).toBe(true);
  });

  /**
   * It is not in the merged set, so the "cannot reach" branch already refuses
   * it. Asserted because a dispatcher that can reach itself is one prompt away
   * from a loop, and the guard should not depend on a fact about another file.
   */
  test('cannot call itself', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'lanes_tools.call',
      profile: 'personal',
      connection: 'example.a',
      arguments: {},
    });

    expect(outcome.isError).toBe(true);
  });

  /**
   * ADR-007's walls are not policy rules, so nothing here evaluates them: a
   * control-plane operation is never registered, so it is never in the merged
   * set, so it refuses for the same reason a misspelling does.
   */
  test('cannot reach a control-plane operation', async () => {
    for (const capability of ['config.connection.create', 'policy.allow', 'token.issue']) {
      const outcome = await call(personal.server.url, {
        capability,
        profile: 'personal',
        connection: 'example.a',
        arguments: {},
      });

      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('cannot reach');
    }
  });
});

/**
 * What the gateway refuses before it reaches anything.
 *
 * The typed tools have always had an argument check: the SDK compiles their
 * input schema at registration and refuses a malformed call itself. Reaching
 * the same capability through `lanes_tools_call` had none — its `arguments` is
 * an open record — so a misspelled field travelled to the vendor, spent a
 * rate-limit unit and an audit row, and came back as whatever error that vendor
 * writes. Under `surface: crunched` every provider call takes this path.
 */
describe('what is checked before the call goes out', () => {
  test('a malformed call is refused, and the refusal carries the schema', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'example.echo',
      profile: 'personal',
      connection: 'example.a',
      // `message` is required; this is the misspelling that used to reach the
      // provider and be answered by it.
      arguments: { mesage: 'typo' },
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('example.echo was not called');
    // The schema comes back with the refusal, so the next turn is a corrected
    // call rather than another search for something the caller already found.
    expect(outcome.text).toContain('```json');
    expect(outcome.text).toContain('message');
    expect(outcome.text).toContain('try again rather than searching for it again');
  });

  test('a well-formed call is untouched by the check', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'example.echo',
      profile: 'personal',
      connection: 'example.a',
      arguments: { message: 'still fine' },
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('still fine');
  });

  /**
   * A refusal that names the schema must still not name what the caller may not
   * reach. The check runs after the reachability tests, so a capability this
   * caller cannot use is refused as unreachable and never gets far enough to
   * have its arguments described.
   */
  test('a denied capability is refused before its schema is described', async () => {
    const outcome = await call(personal.server.url, {
      capability: 'example.list_notes',
      profile: 'personal',
      connection: 'example.a',
      arguments: { nonsense: true },
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).not.toContain('was not called');
    expect(outcome.text).not.toContain('json');
  });
});

describe('filling in a list that came back as references', () => {
  const listing = async (args: Record<string, unknown>) =>
    call(mail.server.url, {
      capability: 'fixture_mail.notes.list',
      profile: 'personal',
      connection: 'fixture_mail.main',
      ...args,
    });

  const bodyOf = (text: string) =>
    JSON.parse(text.split('\n\n')[0] ?? '') as Record<string, unknown>;

  /**
   * The reported failure, end to end. Twenty references went out and five
   * records came back, because the bound was a row count — so the answer to
   * "what is in this account" was four fifths a list of identifiers, and the
   * identifiers it did not fill in had been dropped to make room.
   */
  test('every row comes back, as a record', async () => {
    const { text, isError } = await listing({ arguments: { count: 20 } });
    expect(isError).toBe(false);

    const notes = bodyOf(text)['notes'] as Record<string, unknown>[];
    expect(notes).toHaveLength(20);
    expect(notes.every((note) => typeof note['subject'] === 'string')).toBe(true);
    expect(text).not.toContain('identifiers only');
  });

  /** Paging was impossible while the fill replaced the whole body with the rows. */
  test('what sat beside the array survives it', async () => {
    const { text } = await listing({ arguments: { count: 5 } });

    expect(bodyOf(text)['nextPageToken']).toBe('page-2');
  });

  test('a caller who declines gets what the provider returned', async () => {
    const { text } = await listing({ arguments: { count: 3 }, expand: false });

    const notes = bodyOf(text)['notes'] as Record<string, unknown>[];
    expect(notes).toEqual([
      { id: 'n0', threadId: 't0' },
      { id: 'n1', threadId: 't1' },
      { id: 'n2', threadId: 't2' },
    ]);
  });

  /**
   * Records this size are what 193,271 characters was made of. The budget stops
   * the reply growing without bound, and every row is still there — so the note
   * naming the rest is advice the caller can act on.
   */
  test('records too large to all fit are bounded, and the rest stay as references', async () => {
    const { text } = await listing({ arguments: { count: 20, bytes: 12 * 1024 } });

    const notes = bodyOf(text)['notes'] as Record<string, unknown>[];
    expect(notes).toHaveLength(20);
    expect(notes.at(-1)).toEqual({ id: 'n19', threadId: 't19' });
    expect(text).toContain('came back as identifiers only');
    expect(text).toContain('fixture_mail.notes.get');
    expect(text.length).toBeLessThan(128 * 1024);
  });

  /** `full` is bounded the same way — the reported failure *was* `full` semantics. */
  test('asking for whole records is bounded too, and says where the smaller one is', async () => {
    const { text } = await listing({
      arguments: { count: 20, bytes: 12 * 1024 },
      expand: 'full',
    });

    expect((bodyOf(text)['notes'] as unknown[])).toHaveLength(20);
    expect(text).toContain('expand: "compact"');
    expect(text.length).toBeLessThan(128 * 1024);
  });

  /** The boolean it shipped as still means what it meant, for a client that pinned the schema. */
  test('the boolean this shipped as is still accepted', async () => {
    const { text, isError } = await listing({ arguments: { count: 4 }, expand: true });

    expect(isError).toBe(false);
    expect((bodyOf(text)['notes'] as Record<string, unknown>[])[0]).toMatchObject({
      subject: 're: n0',
    });
  });
});
