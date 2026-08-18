import { describe, expect, test } from 'bun:test';
import { capabilityIdForToolName, scopeResourceUri, toolNameFor, sanitizeSchema } from './index.ts';

/**
 * The wire mapping is where a capability id meets MCP's name grammar. It is
 * load-bearing for the audit log: a refusal is recorded by recovering the id
 * from the name a client asked for.
 */

describe('transliterating to a wire name', () => {
  test('dots become underscores', () => {
    expect(toolNameFor('gmail.search')).toBe('gmail_search');
    expect(toolNameFor('gmail.users.drafts.send')).toBe('gmail_users_drafts_send');
  });
});

describe('recovering a capability id from a wire name', () => {
  test('round-trips a single-segment name without help', () => {
    expect(capabilityIdForToolName('gmail_search')).toBe('gmail.search');
    expect(capabilityIdForToolName('notion_get-comments')).toBe('notion.get-comments');
  });

  test('a dotted name needs the known ids, and is mangled without them', () => {
    // OpenAPI operationIds are dotted, so `gmail.users.drafts.send` transliterates
    // to `gmail_users_drafts_send` and cannot be split back apart.
    expect(capabilityIdForToolName('gmail_users_drafts_send')).toBe('gmail.users_drafts_send');
    expect(
      capabilityIdForToolName('gmail_users_drafts_send', ['gmail.users.drafts.send']),
    ).toBe('gmail.users.drafts.send');
  });

  test('an unknown name still yields something, since the attempt is what matters', () => {
    expect(capabilityIdForToolName('gmail_nonexistent', ['gmail.search'])).toBe(
      'gmail.nonexistent',
    );
  });
});

describe('property names the API will accept', () => {
  // The Anthropic API enforces ^[a-zA-Z0-9_.-]{1,64}$ on every property key and
  // rejects the *whole* tools array when one fails — so Google's `$.xgafv`
  // took down all 107 tools with a 400, not just Gmail's.
  test('an illegal name is dropped', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: { '$.xgafv': { type: 'string' }, userId: { type: 'string' } },
    });

    expect(Object.keys(cleaned['properties'] as object)).toEqual(['userId']);
  });

  test('legal names are untouched, including dots and hyphens', () => {
    const schema = {
      type: 'object',
      properties: { 'user.id': {}, 'page-size': {}, snake_case: {} },
    };
    // Structurally equal, not identical: the walk rebuilds so it can strip
    // formats at any depth without mutating a caller's schema.
    expect(sanitizeSchema(schema)).toEqual(schema);
  });

  test('a required illegal name is kept, to fail loudly rather than silently', () => {
    // Dropping it would register a tool that can never be called correctly.
    const schema = {
      type: 'object',
      properties: { '$weird': { type: 'string' } },
      required: ['$weird'],
    };
    expect(sanitizeSchema(schema)).toEqual(schema);
  });

  test('a name over 64 characters is dropped', () => {
    const long = 'a'.repeat(65);
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: { [long]: {}, ok: {} },
    });
    expect(Object.keys(cleaned['properties'] as object)).toEqual(['ok']);
  });
});

describe('non-standard formats are stripped', () => {
  // OpenAPI and vendor annotations — int64, uint64, byte, google — are not
  // JSON Schema formats. A validator ignores them and logs a warning for every
  // occurrence, every compile, which buries anything worth reading.
  test('a vendor format is removed, the type is kept', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: { historyId: { type: 'string', format: 'uint64', description: 'x' } },
    });

    expect((cleaned['properties'] as any).historyId).toEqual({
      type: 'string',
      description: 'x',
    });
  });

  test('standard formats survive', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: { when: { type: 'string', format: 'date-time' } },
    });
    expect((cleaned['properties'] as any).when.format).toBe('date-time');
  });

  test('it reaches nested schemas, where the warnings actually came from', () => {
    // The reported path was #/properties/message/properties/historyId — a
    // request body two levels down, not a top-level parameter.
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: {
        message: {
          type: 'object',
          properties: { historyId: { type: 'string', format: 'uint64' } },
        },
      },
    });

    expect((cleaned['properties'] as any).message.properties.historyId.format).toBeUndefined();
  });

  test('arrays are walked too', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: { sizes: { type: 'array', items: { type: 'integer', format: 'int64' } } },
    });
    expect((cleaned['properties'] as any).sizes.items.format).toBeUndefined();
  });
});

describe('routing a resource URI', () => {
  // A resource has no argument to route on, so the profile and the connection
  // live in the URI itself (ADR-006). This used to be done by replacing the
  // literal token `{key}`, which meant every provider that named its variable
  // anything else registered a URI carrying no routing at all — and two
  // connections would have collided on one address.
  const scope = { profile: 'personal', connectionId: 'a' };

  test('inserts after the authority, ahead of the provider\u2019s own path', () => {
    expect(scopeResourceUri('example://note/{key}', scope)).toBe('example://note/personal/a/{key}');
  });

  test('works for a variable that is not called key', () => {
    expect(scopeResourceUri('memory://entry/{id}', scope)).toBe('memory://entry/personal/a/{id}');
  });

  test('works for a concrete URI, which is what a listing returns', () => {
    expect(scopeResourceUri('memory://entry/standup', scope)).toBe(
      'memory://entry/personal/a/standup',
    );
  });

  test('a fixed URI with no path still gets routed', () => {
    expect(scopeResourceUri('config://app', scope)).toBe('config://app/personal/a');
  });

  test('two connections never share an address', () => {
    expect(scopeResourceUri('memory://entry/{id}', { profile: 'personal', connectionId: 'a' })).not.toBe(
      scopeResourceUri('memory://entry/{id}', { profile: 'personal', connectionId: 'b' }),
    );
  });

  test('deeper paths keep their shape', () => {
    expect(scopeResourceUri('m://x/y/{id}/parts', scope)).toBe('m://x/personal/a/y/{id}/parts');
  });
});
