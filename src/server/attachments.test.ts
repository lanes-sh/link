import { afterAll, describe, expect, test } from 'bun:test';
import { allocatePort, startHarness, TEST_TOKEN } from './harness.ts';

/**
 * The upload route, against a real server on a real port.
 *
 * It exists because a tool argument cannot carry a file: base64 in a tool call
 * puts a 239 KB PDF at ~320,000 characters of model output, and MCP offers no
 * client-to-server binary channel in any released version. So bytes arrive here
 * over ordinary HTTP and a handle travels through the model instead.
 *
 * What is worth proving on a real socket rather than a mock: the bearer check
 * applies, an account the token cannot reach is refused, and a handle comes back
 * scoped to the connection that was named.
 */

const endpoint = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"`,
});

/**
 * A token allowed nothing on any registered provider.
 *
 * Policy rules name capabilities, never accounts — `allowedConnections` is
 * explicit that beyond the provider it is all or nothing — so "reachable" cannot
 * be narrowed to one account of a provider. What it *can* be is empty, which is
 * the case worth proving: a token with no capability on a provider must not be
 * able to write bytes into that provider's namespace.
 */
const narrow = startHarness({
  profile: 'work',
  port: allocatePort(),
  token: 'llk_work_token_value',
  policy: `  allow:
    - "example.*"
  deny:
    - "example.*"`,
});

afterAll(async () => {
  await Promise.all([endpoint.stop(), narrow.stop()]);
});

/** `Response.json()` is `unknown`; every body here is a JSON object. */
const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

/** `server.url` points at the MCP path, so the route is reached from its origin. */
const stage = async (
  base: string,
  init: {
    query?: string;
    token?: string | null;
    filename?: string;
    contentType?: string;
    body?: Uint8Array;
  } = {},
): Promise<Response> => {
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'application/pdf',
  };
  if (init.token !== null) headers['authorization'] = `Bearer ${init.token ?? TEST_TOKEN}`;
  if (init.filename) headers['x-filename'] = init.filename;

  const origin = new URL(base).origin;
  return fetch(`${origin}/attachments?${init.query ?? 'connection=example.a'}`, {
    method: 'POST',
    headers,
    body: init.body ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  });
};

/** The download half: same path, same query, a handle instead of a body. */
const collect = async (
  base: string,
  init: { handle: string; connection?: string; token?: string | null },
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers['authorization'] = `Bearer ${init.token ?? TEST_TOKEN}`;

  const origin = new URL(base).origin;
  const connection = init.connection ?? 'example.a';
  return fetch(`${origin}/attachments?connection=${connection}&handle=${init.handle}`, { headers });
};

describe('handing bytes back', () => {
  test('a staged file round-trips, byte for byte, with its name and type', async () => {
    // The direction that did not exist. An attachment could be described by
    // get_message and forwarded by send_message, and there was no way to simply
    // have it — so a file that arrived by mail was unreachable except by mailing
    // it somewhere else.
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const staged = (await json(
      await stage(endpoint.server.url, { filename: 'card.pdf', body: bytes }),
    )) as { handle: string };

    const response = await collect(endpoint.server.url, { handle: staged.handle });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-disposition')).toContain('card.pdf');
    // Not a shared cache's business, however unguessable the handle is.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('a non-ASCII filename survives, both ways round', async () => {
    // RFC 6266. A raw header would be rejected outright, and mail attachments
    // are exactly where this bites.
    const staged = (await json(
      await stage(endpoint.server.url, { filename: 'Rechnung_Kaufmännisch.pdf' }),
    )) as { handle: string };

    const disposition =
      (await collect(endpoint.server.url, { handle: staged.handle })).headers.get(
        'content-disposition',
      ) ?? '';

    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent('Rechnung_Kaufmännisch.pdf'));
    // The ASCII fallback stays ASCII, or the header is invalid for old clients.
    const fallback = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
    expect(fallback).toMatch(/^[\x20-\x7e]*$/);
  });

  test('a handle staged for one connection is not fetchable from another', async () => {
    // The property the whole scoping exists for. `example.b` is reachable for
    // this token exactly as `example.a` is, so this is not a policy refusal —
    // it is the namespace, and it has to hold even between two accounts the
    // caller may otherwise use.
    const staged = (await json(
      await stage(endpoint.server.url, { query: 'connection=example.a' }),
    )) as { handle: string };

    const response = await collect(endpoint.server.url, {
      handle: staged.handle,
      connection: 'example.b',
    });

    expect(response.status).toBe(404);
  });

  test('an unknown handle is a 404, told the same way as a wrong connection', async () => {
    const response = await collect(endpoint.server.url, {
      handle: 'att_00000000000000000000000000000000',
    });

    expect(response.status).toBe(404);
  });

  test('a malformed handle is refused before it reaches the store', async () => {
    const response = await collect(endpoint.server.url, { handle: '../../etc/passwd' });

    expect(response.status).toBe(400);
  });

  test('a fetch still needs the bearer token', async () => {
    const staged = (await json(await stage(endpoint.server.url))) as { handle: string };

    const response = await collect(endpoint.server.url, { handle: staged.handle, token: null });

    expect(response.status).toBe(401);
  });

  test('a token that cannot reach the connection cannot fetch from it either', async () => {
    const staged = (await json(await stage(endpoint.server.url))) as { handle: string };

    const response = await collect(narrow.server.url, {
      handle: staged.handle,
      token: 'llk_work_token_value',
    });

    expect(response.status).toBe(403);
  });
});

describe('staging bytes for a later call', () => {
  test('returns a handle, a digest, and an expiry', async () => {
    const response = await stage(endpoint.server.url, { filename: 'invoice.pdf' });

    expect(response.status).toBe(200);
    const body = await json(response);

    expect(body['handle']).toMatch(/^att_[0-9a-f]{32}$/);
    expect(body['filename']).toBe('invoice.pdf');
    expect(body['bytes']).toBe(4);
    expect(body['content_type']).toBe('application/pdf');
    // Verified out of band: `printf '\x25\x50\x44\x46' | shasum -a 256`.
    expect(body['sha256']).toBe(
      '315d429b7714cedb6ad04ac31240145257692630457f3c88253c5beceac76027',
    );
    expect(body['connection']).toBe('example.a');
    expect(String(body['expires_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The hint is what a caller needs next, spelled out.
    expect(String(body['hint'])).toContain('"handle"');
  });

  test('two uploads never share a handle', async () => {
    const first = (await json(await stage(endpoint.server.url))) as { handle: string };
    const second = (await json(await stage(endpoint.server.url))) as { handle: string };

    expect(first.handle).not.toBe(second.handle);
  });

  test('the digest is of the bytes that arrived', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const response = await stage(endpoint.server.url, { body: bytes });

    // Verified out of band: `printf '\x01\x02\x03\x04' | shasum -a 256`.
    expect((await json(response))['sha256']).toBe(
      '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
    );
  });

  test('a filename with a path in it keeps only the basename', async () => {
    // The value is echoed into a Content-Disposition and stored beside the
    // bytes. Neither wants a path, and neither wants traversal.
    const response = await stage(endpoint.server.url, { filename: '../../etc/passwd' });

    expect((await json(response))['filename']).toBe('passwd');
  });

  test('no filename is still a valid attachment', async () => {
    expect((await json(await stage(endpoint.server.url)))['filename']).toBe('attachment');
  });
});

describe('what it refuses', () => {
  test('an unauthenticated upload', async () => {
    const response = await stage(endpoint.server.url, { token: null });

    expect(response.status).toBe(401);
  });

  test('a bad token', async () => {
    const response = await stage(endpoint.server.url, { token: 'llk_wrong' });

    expect(response.status).toBe(401);
  });

  test('an upload naming no connection, with the shape it wants', async () => {
    const response = await stage(endpoint.server.url, { query: '' });

    expect(response.status).toBe(400);
    expect(String((await json(response))['error'])).toContain('?connection=');
  });

  test('a provider this token has no capability on', async () => {
    // Staging into an account the caller cannot act on would be a write they are
    // not permitted to make, even though nothing is sent by it.
    const response = await stage(narrow.server.url, {
      token: 'llk_work_token_value',
      query: 'connection=example.a',
    });

    expect(response.status).toBe(403);
    expect(String((await json(response))['error'])).toContain('not reachable');
  });

  test('an account that does not exist', async () => {
    // Without this, a caller could name any `provider/connection` they liked and
    // write bytes into a namespace of their own choosing.
    const response = await stage(endpoint.server.url, { query: 'connection=example.zzz' });

    expect(response.status).toBe(403);
  });

  test('a provider that does not exist', async () => {
    const response = await stage(endpoint.server.url, { query: 'connection=invented.a' });

    expect(response.status).toBe(403);
  });

  test('a profile that is not served', async () => {
    const response = await stage(endpoint.server.url, {
      query: 'profile=nope&connection=example.a',
    });

    expect(response.status).toBe(404);
  });

  test('an empty body, since there is nothing to stage', async () => {
    const response = await stage(endpoint.server.url, { body: new Uint8Array() });

    expect(response.status).toBe(400);
    expect(String((await json(response))['error'])).toContain('empty');
  });

  test('a method that is neither direction, naming the two that are', async () => {
    // GET used to be refused here. It is the download half now — the same path,
    // the same scoping — so the refusal moved to the methods that mean nothing
    // on this route rather than being deleted.
    const response = await fetch(`${new URL(endpoint.server.url).origin}/attachments?connection=example.a`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.status).toBe(405);
    expect(await response.text()).toMatch(/POST.*GET|GET.*POST/s);
  });

  test('a GET with no handle says what is missing rather than 404ing', async () => {
    const response = await fetch(`${new URL(endpoint.server.url).origin}/attachments?connection=example.a`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/handle/);
  });

  test('an unknown path is still a 404, so the route did not widen the surface', async () => {
    const response = await fetch(`${new URL(endpoint.server.url).origin}/attachments-not-really`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.status).toBe(404);
  });
});

describe('the audit log', () => {
  test('records that a file entered the endpoint, by name and digest', async () => {
    // Staging puts the operator's file inside the endpoint, where a later send
    // can post it outward. That belongs in the same log as the send.
    await stage(endpoint.server.url, { filename: 'contract.pdf' });

    const events = await endpoint.audit.tail({ capability: 'attachments.stage' });
    const latest = events.find(
      (event) => (event.arguments as { filename?: string }).filename === 'contract.pdf',
    );

    expect(latest).toBeDefined();
    expect(latest?.connection).toBe('example.a');
    expect(latest?.status).toBe('ok');
    expect(latest?.arguments).toMatchObject({
      filename: 'contract.pdf',
      bytes: 4,
      content_type: 'application/pdf',
    });
  });
});
