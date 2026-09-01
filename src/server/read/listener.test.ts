import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { serveRead, type AuditTail, type RunningReadListener } from './listener.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';

/**
 * The one surface a browser origin may read on loopback (ADR-063).
 *
 * ADR-039 refuses cross-origin access here, and this narrows that refusal
 * rather than lifting it. So every test below is about the *narrowness*: one
 * origin, one credential that cannot call a tool, nothing ambient, and no
 * mutation reachable at all.
 *
 * Driven over real TLS against a real listener, because the properties in
 * question are headers on a wire. A unit test of the handler would pass while
 * the browser refused every request.
 */

const ORIGIN = 'https://lanes.sh';
const TOKEN = 'llp_a-pairing-token';

let listener: RunningReadListener;

/** The token the listener will accept, so a rotation can be driven mid-test. */
let current: string = TOKEN;
let base: string;

/**
 * A self-signed certificate, generated once.
 *
 * `mkcert` is what `lanes link pair` uses, because a browser has to trust the
 * result. Nothing here is a browser, so this only has to be a valid certificate
 * — `Bun.fetch` is told not to check it, which is the one place that is
 * acceptable and is why it is spelled out rather than configured globally.
 */
function selfSigned(): { cert: string; key: string } {
  const key = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '/dev/stdout', '-out', '/dev/stdout', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);

  const out = key.stdout.toString();
  const keyStart = out.indexOf('-----BEGIN PRIVATE KEY-----');
  const keyEnd = out.indexOf('-----END PRIVATE KEY-----') + '-----END PRIVATE KEY-----'.length;
  const certStart = out.indexOf('-----BEGIN CERTIFICATE-----');
  const certEnd = out.indexOf('-----END CERTIFICATE-----') + '-----END CERTIFICATE-----'.length;

  return { key: out.slice(keyStart, keyEnd), cert: out.slice(certStart, certEnd) };
}

const AUDIT: AuditTail = {
  tail: async () => [
    {
      id: 'evt_1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      profile: 'personal',
      principal: 'lanes:HER',
      provider: 'gmail',
      connection: 'gmail.personal',
      capability: 'gmail.users.messages.list',
      arguments: { q: '<redacted>' },
      authorization: 'allowed',
    },
    {
      id: 'evt_2',
      timestamp: new Date('2026-01-01T00:01:00.000Z'),
      profile: 'work',
      principal: 'lanes:HER',
      provider: 'gmail',
      capability: 'gmail.users.messages.get',
      arguments: {},
      authorization: 'denied_default',
    },
  ],
};

/** No profiles: this file is about the wire, and `state.test.ts` is about the body. */
const PROFILES = new Map<string, ProfileRuntime>();

beforeAll(() => {
  listener = serveRead({
    host: '127.0.0.1',
    // Zero lets the kernel pick, so a suite run twice at once does not collide.
    port: 0,
    workspace: 'local',
    profiles: () => PROFILES,
    audit: AUDIT,
    connections: async () => [],
    token: async () => current,
    tls: selfSigned(),
  });
  base = listener.url;
});

afterAll(() => listener.stop());

function at(path: string): string {
  return `${base}${path}`;
}

function read(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(at(path), {
    ...init,
    headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    tls: { rejectUnauthorized: false },
  } as RequestInit);
}

describe('the credential', () => {
  test('a paired page reads the workspace', async () => {
    const response = await read('/state');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: 'local' });
  });

  test('no token reads nothing, and is told the one command that fixes it', async () => {
    // Every local failure looks identical from a browser: an expired
    // certificate, a rotated token, a listener that is not running. So the
    // answer is always the command that fixes all of them.
    const response = await read('/state', { headers: { authorization: '' } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unpaired', run: 'lanes link pair' });
  });

  test('a rotated-away token reads nothing', async () => {
    const response = await read('/state', {
      headers: { authorization: 'Bearer llp_the-previous-one' },
    });

    expect(response.status).toBe(401);
  });

  test('no cookie is ever accepted, so nothing is ambient', async () => {
    // The safety of this surface rests on the credential being one the page
    // must already hold. `access-control-allow-credentials` would undo that,
    // so its absence is asserted rather than assumed.
    const response = await read('/state');

    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('the origin', () => {
  test('is echoed, never wildcarded', async () => {
    // A deployed endpoint may wildcard because it is already publicly
    // reachable. Loopback is not, so a page reaching it is stealing
    // reachability that nothing else has.
    const response = await read('/state');

    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  test('any other origin is refused before the surface answers', async () => {
    const response = await read('/state', { headers: { origin: 'https://evil.example' } });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('Vary: Origin is set even on a refusal', async () => {
    // Without it a cache between here and the page can serve one origin's
    // answer to another, which is the whole grant leaking through an
    // intermediary.
    const refused = await read('/state', { headers: { origin: 'https://evil.example' } });

    expect(refused.headers.get('vary')).toBe('Origin');
  });

  test('a preflight is answered without a credential, because it carries none', async () => {
    const response = await fetch(at('/state'), {
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
      tls: { rejectUnauthorized: false },
    } as RequestInit);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization');
  });

  test('a preflight from anywhere else is refused', async () => {
    const response = await fetch(at('/state'), {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
      tls: { rejectUnauthorized: false },
    } as RequestInit);

    expect(response.status).toBe(403);
  });
});

describe('what can be reached', () => {
  test('the audit log, most recent entries, already redacted', async () => {
    const response = await read('/audit?limit=10');
    const body = (await response.json()) as { events: { id: string; arguments: unknown }[] };

    expect(body.events).toHaveLength(2);
    // Redacted where it was written, and not redacted again here: a second rule
    // would be a second answer to what is sensitive.
    expect(body.events[0]?.arguments).toEqual({ q: '<redacted>' });
  });

  test('the log narrows to one profile', async () => {
    const response = await read('/audit?profile=work');
    const body = (await response.json()) as { events: { id: string }[] };

    expect(body.events.map((event) => event.id)).toEqual(['evt_2']);
  });

  test('nothing else, and an unknown path does not confirm what this is', async () => {
    const response = await read('/anything');

    expect(response.status).toBe(404);
  });

  test('no method but GET, and a write is a 404 rather than a 405', async () => {
    // A `405` would confirm to any page on the machine that a Lanes read
    // listener is here. There is no mutation to allow, so there is nothing for
    // "method not allowed" to mean.
    const response = await read('/state', { method: 'POST' });

    expect(response.status).toBe(404);
  });
});

describe('rotating the pairing token', () => {
  test('the new one is accepted and the old one stops, without a restart', async () => {
    // `lanes link pair --rotate` writes a new token and tells the operator the
    // previous link no longer works. Captured at boot it did neither: the live
    // listener kept accepting the old token and refused the new one until the
    // endpoint was restarted, so a stolen credential went on reading the whole
    // workspace while the command that was meant to take it back reported
    // success.
    expect((await read('/state')).status).toBe(200);

    current = 'llp_rotated';

    const old = await read('/state');
    expect(old.status).toBe(401);

    const rotated = await read('/state', {
      headers: { authorization: 'Bearer llp_rotated' },
    });
    expect(rotated.status).toBe(200);

    current = TOKEN;
  });

  test('an unpaired workspace refuses rather than admitting anything', async () => {
    // `--rotate` between the read and the write, or a credential store that
    // cannot be opened. Null is not a token to compare against.
    current = null as unknown as string;

    expect((await read('/state')).status).toBe(401);

    current = TOKEN;
  });
});
