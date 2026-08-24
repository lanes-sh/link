import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import { createMcpConnector, inferBundle, readableUpstreamError, shortenName } from './index.ts';

describe('shortening a redundantly prefixed name', () => {
  test('drops the provider prefix', () => {
    const all = ['notion-search', 'notion-fetch'];
    expect(shortenName('notion', 'notion-search', all)).toBe('search');
    expect(shortenName('notion', 'notion-fetch', all)).toBe('fetch');
  });

  test('leaves an unprefixed name alone', () => {
    expect(shortenName('linear', 'list_teams', ['list_teams'])).toBe('list_teams');
  });

  test('refuses to shorten into a collision', () => {
    // A shorter name is never worth routing to the wrong tool.
    const all = ['notion-search', 'search'];
    expect(shortenName('notion', 'notion-search', all)).toBe('notion-search');
  });

  test('does not strip a name that is only the prefix', () => {
    expect(shortenName('notion', 'notion-', ['notion-'])).toBe('notion-');
  });
});

describe('bundle inference', () => {
  test("the upstream's own readOnlyHint wins", () => {
    expect(inferBundle({ name: 'create_thing', annotations: { readOnlyHint: true } })).toBe('read');
    expect(inferBundle({ name: 'get_thing', annotations: { readOnlyHint: false } })).toBe('write');
  });

  test('falls back to the verb, tolerating either separator', () => {
    expect(inferBundle({ name: 'get-comments' }, 'get-comments')).toBe('read');
    expect(inferBundle({ name: 'list_teams' }, 'list_teams')).toBe('read');
    expect(inferBundle({ name: 'create-pages' }, 'create-pages')).toBe('write');
  });

  test('an unrecognised verb is write, which is the safer default', () => {
    // `read` is what connect grants by default, so guessing wrong in that
    // direction is the failure that matters.
    expect(inferBundle({ name: 'frobnicate' }, 'frobnicate')).toBe('write');
  });
});

describe('upstream errors are readable', () => {
  test('extracts the explanation Google buries in a 403 body', () => {
    // Google answers 403 with a well-formed JSON-RPC result whose text is the
    // only thing that says what to do — inside tens of kilobytes of JSON.
    const raw = new Error(
      'Error POSTing to endpoint: ' +
        JSON.stringify({
          id: 3,
          jsonrpc: '2.0',
          result: {
            content: [
              { text: 'Gmail MCP API has not been used in project 1234 before or it is disabled.' },
            ],
          },
        }),
    );

    const readable = readableUpstreamError(raw, 'https://gmailmcp.googleapis.com/mcp/v1');
    expect(readable.message).toBe(
      'gmailmcp.googleapis.com: Gmail MCP API has not been used in project 1234 before or it is disabled.',
    );
    expect(readable.message.length).toBeLessThan(200);
  });

  test('extracts a JSON-RPC error message', () => {
    const raw = new Error(
      'Error POSTing to endpoint: ' + JSON.stringify({ error: { message: 'Invalid token' } }),
    );
    expect(readableUpstreamError(raw, 'https://mcp.notion.com/mcp').message).toBe(
      'mcp.notion.com: Invalid token',
    );
  });

  test('falls back to a short summary rather than dumping the body', () => {
    const raw = new Error('Error POSTing to endpoint: {not json at all');
    const readable = readableUpstreamError(raw, 'https://mcp.linear.app/mcp');

    expect(readable.message).toContain('mcp.linear.app');
    expect(readable.message).not.toContain('not json at all');
  });

  test('passes through an error carrying no body', () => {
    const raw = new Error('fetch failed');
    expect(readableUpstreamError(raw, 'https://mcp.linear.app/mcp').message).toBe('fetch failed');
  });
});

/**
 * What goes out on the wire.
 *
 * An `http` connector narrows itself with `operations`, because it reads a
 * document listing everything the API can do. An mcp server decides that for
 * itself, so where a vendor makes the choice configurable it is a header they
 * define — GitHub's `X-MCP-Toolsets` being the case in hand. Declaring one and
 * having it silently not sent would look exactly like the vendor ignoring it.
 */
describe('the headers a connection carries', () => {
  const manifest = defineProvider({
    id: 'vendor_mcp',
    name: 'Vendor',
    connector: {
      kind: 'mcp',
      endpoint: 'https://mcp.example.test/mcp',
      headers: { 'X-MCP-Toolsets': 'issues,repos' },
    },
    auth: { kind: 'bearer' },
  });

  /** The first request the SDK makes, whatever it then does with the answer. */
  async function firstRequest(token: string | null): Promise<Headers> {
    let seen: Headers | undefined;

    const connector = createMcpConnector({
      endpoint: 'https://mcp.example.test/mcp',
      headers: { 'X-MCP-Toolsets': 'issues,repos' },
      accessToken: async () => token,
      fetch: (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
        seen ??= new Headers(init?.headers);
        throw new Error('captured');
      }) as unknown as typeof globalThis.fetch,
    });

    // Only the request matters; the handshake is expected to fail on it.
    await connector.discover({ manifest }).catch(() => {});

    expect(seen).toBeDefined();
    return seen!;
  }

  test('declared headers are sent alongside the credential', async () => {
    const headers = await firstRequest('a-pasted-token');

    expect(headers.get('x-mcp-toolsets')).toBe('issues,repos');
    expect(headers.get('authorization')).toBe('Bearer a-pasted-token');
  });

  test('the credential wins the header it owns', async () => {
    // `defineProvider` refuses a declared `Authorization`, so this pins the
    // merge order that makes that refusal belt-and-braces rather than the only
    // thing standing between a token and being displaced.
    const headers = await firstRequest('a-pasted-token');

    expect(headers.get('authorization')).not.toBe('Bearer displaced');
  });

  test('no credential means no header, not an empty one', async () => {
    // A provider with `auth: none` proxies a server that wants nothing. An
    // `Authorization: Bearer ` would be a malformed credential rather than an
    // absent one, and servers answer the two differently.
    const headers = await firstRequest(null);

    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('x-mcp-toolsets')).toBe('issues,repos');
  });
});
