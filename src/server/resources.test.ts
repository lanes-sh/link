import { afterAll, describe, expect, test } from 'bun:test';
import { allocatePort, rpc, startHarness } from './harness.ts';

/**
 * Resources, end to end over real HTTP.
 *
 * `example://note/{key}` has been declared since M1 and no runtime path could
 * read it: the local connector dropped every non-tool capability in `discover`
 * and threw `"is not a tool"` in `invoke`, so the registration in
 * `packages/mcp` dispatched into a wall. These tests are the proof that the
 * seam works, and they are what the owner layer's memory resources stand on.
 *
 * The registered URI carries the profile and the connection because a resource
 * has no argument to route on (ADR-006). That is asserted here rather than
 * assumed: it used to be produced by replacing the literal token `{key}`, which
 * silently did nothing for any provider that named its variable anything else.
 */

/** Full access, both connections. */
const owner = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"`,
});

/** Tools only: the note resource is withheld, so it must not be advertised. */
const toolsOnly = startHarness({
  profile: 'personal',
  port: allocatePort(),
  token: 'llk_tools_only_token',
  policy: `  allow:
    - "example.get_note"
    - "example.set_note"`,
});

afterAll(async () => {
  await Promise.all([owner.stop(), toolsOnly.stop()]);
});

async function setNote(connection: string, key: string, value: string): Promise<void> {
  await rpc(owner.server.url, 'tools/call', {
    name: 'example_set_note',
    arguments: { profile: 'personal', connection, key, value },
  });
}

async function readResource(uri: string, options: { url?: string; token?: string } = {}) {
  const response = await rpc(
    options.url ?? owner.server.url,
    'resources/read',
    { uri },
    options.token ? { token: options.token } : {},
  );

  return {
    contents:
      (response.body['result'] as { contents?: Array<{ uri: string; text?: string; mimeType?: string }> })
        ?.contents ?? [],
    error: response.body['error'] as { message?: string } | undefined,
  };
}

describe('a resource is registered per reachable connection', () => {
  test('the template carries the profile and the connection', async () => {
    const response = await rpc(owner.server.url, 'resources/templates/list', {});
    const templates = (response.body['result'] as {
      resourceTemplates?: Array<{ name: string; uriTemplate: string }>;
    })?.resourceTemplates ?? [];

    const uris = templates.map((template) => template.uriTemplate).sort();

    // Inserted after the authority, ahead of the provider's own path — so a
    // template naming `{id}` rather than `{key}` is routed just as well.
    expect(uris).toEqual([
      'example://note/personal/a/{key}',
      'example://note/personal/b/{key}',
    ]);
  });

  test('a profile without the grant is not offered it at all', async () => {
    const response = await rpc(
      toolsOnly.server.url,
      'resources/templates/list',
      {},
      { token: 'llk_tools_only_token' },
    );

    const templates = (response.body['result'] as { resourceTemplates?: unknown[] })
      ?.resourceTemplates ?? [];

    expect(templates).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain('example://note');
  });
});

describe('reading a resource', () => {
  test('returns what the provider stored', async () => {
    await setNote('example.a', 'greeting', 'hello from a');

    const { contents } = await readResource('example://note/personal/a/greeting');

    expect(contents).toHaveLength(1);
    expect(contents[0]?.text).toBe('hello from a');
    // The URI the client asked for, so the contents can be re-read from what
    // they name. MCP requires the two to agree.
    expect(contents[0]?.uri).toBe('example://note/personal/a/greeting');
    expect(contents[0]?.mimeType).toBe('text/plain');
  });

  test('the connection in the URI is the one that is read', async () => {
    await setNote('example.a', 'shared', 'value on a');
    await setNote('example.b', 'shared', 'value on b');

    expect((await readResource('example://note/personal/a/shared')).contents[0]?.text).toBe(
      'value on a',
    );
    expect((await readResource('example://note/personal/b/shared')).contents[0]?.text).toBe(
      'value on b',
    );
  });

  test('a missing note is an error rather than empty contents', async () => {
    const { error, contents } = await readResource('example://note/personal/a/absent');

    expect(contents).toEqual([]);
    expect(error?.message ?? '').toContain('absent');
  });

  test('a withheld resource cannot be read by naming its URI', async () => {
    // Discovery filtering hides it; this is the other half — that guessing the
    // address does not work either.
    const { error } = await readResource('example://note/personal/a/greeting', {
      url: toolsOnly.server.url,
      token: 'llk_tools_only_token',
    });

    expect(error).toBeDefined();
  });
});

describe('listing resources', () => {
  test('enumerates through the provider, with routed URIs', async () => {
    await setNote('example.a', 'first', '1');
    await setNote('example.a', 'second', '2');

    const response = await rpc(owner.server.url, 'resources/list', {});
    const resources = (response.body['result'] as {
      resources?: Array<{ uri: string; name: string }>;
    })?.resources ?? [];

    const onA = resources.filter((resource) => resource.uri.startsWith('example://note/personal/a/'));

    expect(onA.map((resource) => resource.uri)).toContain('example://note/personal/a/first');
    expect(onA.map((resource) => resource.uri)).toContain('example://note/personal/a/second');
    // The provider returns its own unrouted form; core rewrites it, or a client
    // would be handed addresses it cannot read.
    expect(resources.map((resource) => resource.uri)).not.toContain('example://note/first');
  });

  test('what one connection stored is not listed under another', async () => {
    await setNote('example.b', 'only-on-b', 'x');

    const response = await rpc(owner.server.url, 'resources/list', {});
    const resources = (response.body['result'] as { resources?: Array<{ uri: string }> })
      ?.resources ?? [];
    const uris = resources.map((resource) => resource.uri);

    expect(uris).toContain('example://note/personal/b/only-on-b');
    expect(uris).not.toContain('example://note/personal/a/only-on-b');
  });
});

describe('a resource read is audited like every other invocation', () => {
  test('one event, naming the capability and the connection', async () => {
    await setNote('example.a', 'audited', 'secret content');

    const before = (await owner.audit.tail({ capability: 'example.note' })).length;
    await readResource('example://note/personal/a/audited');
    const events = await owner.audit.tail({ capability: 'example.note' });

    expect(events.length).toBe(before + 1);

    const event = events[0]!;
    expect(event.capability).toBe('example.note');
    expect(event.connection).toBe('example.a');
    expect(event.authorization).toBe('allowed');
    expect(event.status).toBe('ok');
  });

  test('the note contents never reach the log', async () => {
    await setNote('example.a', 'private', 'the body of the note');
    await readResource('example://note/personal/a/private');

    const events = await owner.audit.tail({ capability: 'example.note' });

    expect(JSON.stringify(events)).not.toContain('the body of the note');
  });

  test('a read of an unadvertised resource leaves no trace — a known gap', async () => {
    // Asserting the gap rather than hiding it. A capability this profile cannot
    // reach is never registered, so the SDK answers "not found" before dispatch
    // runs. `apps/server/src/index.ts` catches exactly that for `tools/call`
    // and `prompts/get`, recording a refusal — "an agent probing for tools it
    // does not have is precisely the behaviour the log exists to capture".
    //
    // It cannot for `resources/read`: the header mirrors `params.uri`, not a
    // wire name, so recovering a capability id means matching the URI against
    // every registered template. M4 did not take that on.
    //
    // Change this expectation when it is; do not delete it.
    const { error } = await readResource('example://note/personal/a/greeting', {
      url: toolsOnly.server.url,
      token: 'llk_tools_only_token',
    });

    expect(error).toBeDefined();
    expect(await toolsOnly.audit.tail({ deniedOnly: true })).toEqual([]);
  });
});
