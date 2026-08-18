import { describe, expect, test } from 'bun:test';
import { inferBundle, readableUpstreamError, shortenName } from './index.ts';

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
