import { describe, expect, test } from 'bun:test';
import type { AuthStrategyContext, ProviderManifest } from '#connectivity';
import { createBunqStrategy } from './index.ts';
import { PRODUCTION, SANDBOX } from './handshake.ts';
import { generateKeypair, signBody } from './keys.ts';

/**
 * The strategy against a bunq that is not there.
 *
 * Everything worth pinning here is a sequence rather than a value: that setup
 * performs three calls and not two, that a second request does not open a
 * second session, that two concurrent ones do not either, and that a 401 leaves
 * the connection able to recover on its own. Those are the failures that would
 * otherwise be found against a real bank.
 */

let counter = 0;
/** A fresh connection per test: the session cache is per process and keyed by it. */
const nextConnection = () => `c${++counter}`;

const manifestFor = (baseUrl: string) =>
  ({
    id: 'bunq',
    connector: { kind: 'http', base_url: baseUrl },
    auth: { kind: 'strategy', strategy: 'bunq' },
  }) as unknown as ProviderManifest;

const manifest = manifestFor(PRODUCTION);

interface Bench {
  readonly context: AuthStrategyContext;
  readonly calls: Array<{ url: string; path: string; headers: Headers; body: string }>;
  readonly secrets: Map<string, string>;
  readonly state: Map<string, string>;
  /** Status the next non-handshake call answers with. */
  status: number;
}

function bench(
  baseUrl: string = PRODUCTION,
  seed: 'raw-key' | 'installed' | 'none' = 'installed',
  connectionId = nextConnection(),
  profile = 'personal',
): Bench {
  const calls: Bench['calls'] = [];
  const secrets = new Map<string, string>();
  const state = new Map<string, string>();
  const ref = `bunq/${connectionId}`;

  const keys = generateKeypair();
  if (seed === 'raw-key') secrets.set(ref, 'api-key-from-the-app');
  if (seed === 'installed') {
    secrets.set(
      ref,
      JSON.stringify({
        api_key: 'api-key-from-the-app',
        private_key: keys.privateKey,
        installation_token: 'installation-token',
        server_public_key: keys.publicKey,
      }),
    );
  }

  const self: Bench = {
    calls,
    secrets,
    state,
    status: 200,
    context: {
      manifest: manifestFor(baseUrl),
      connectionId,
      profile,
      credentials: {
        async get(reference: string) {
          return secrets.get(reference) ?? null;
        },
        async has(reference: string) {
          return secrets.has(reference);
        },
      },
      write: async (reference: string, value: string) => {
        secrets.set(reference, value);
      },
      state: {
        async get(key: string) {
          return state.get(key) ?? null;
        },
        async set(key: string, value: string) {
          state.set(key, value);
        },
        async delete(key: string) {
          state.delete(key);
        },
        async keys() {
          return [...state.keys()];
        },
        async getJson<T>(key: string) {
          const raw = state.get(key);
          return raw ? (JSON.parse(raw) as T) : null;
        },
        async setJson(key: string, value: unknown) {
          state.set(key, JSON.stringify(value));
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      options: {},
    } as unknown as AuthStrategyContext,
  };

  return self;
}

function stub(target: Bench): typeof globalThis.fetch {
  return (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url).pathname;
    target.calls.push({
      url,
      path,
      headers: new Headers(init?.headers ?? {}),
      body: String(init?.body ?? ''),
    });

    if (path.endsWith('/installation')) {
      return Response.json({
        Response: [
          { Id: { id: 1 } },
          { Token: { token: 'installation-token' } },
          { ServerPublicKey: { server_public_key: 'server-public-key' } },
        ],
      });
    }
    if (path.endsWith('/device-server')) return Response.json({ Response: [{ Id: { id: 2 } }] });
    if (path.endsWith('/session-server')) {
      return Response.json({
        Response: [
          { Id: { id: 3 } },
          // Stamped with the profile, so a token that crossed a profile
          // boundary is visible rather than coincidentally equal.
          { Token: { token: `session-${target.context.profile}-${target.calls.length}` } },
        ],
      });
    }

    return Response.json({ Response: [] }, { status: target.status });
  }) as unknown as typeof globalThis.fetch;
}

const payment = (host: string = PRODUCTION) =>
  new Request(`${host}/user/1/monetary-account/2/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: { value: '10.00', currency: 'EUR' } }),
  });

describe('setup', () => {
  test('installs and registers the device, and stops there', async () => {
    // No session. `connect` runs this under a provisional connection id and
    // renames afterwards, so a session opened here would be stranded under the
    // old id — and `/session-server` allows one call per thirty seconds, which
    // makes a stranded session a refused first call rather than a wasted one.
    const target = bench(PRODUCTION, 'raw-key');
    await createBunqStrategy(stub(target)).setup!(target.context);

    expect(target.calls.map((c) => c.path)).toEqual(['/v1/installation', '/v1/device-server']);
  });

  test('replaces the pasted key with the whole context, under the one ref a connection may read', async () => {
    const target = bench(PRODUCTION, 'raw-key');
    await createBunqStrategy(stub(target)).setup!(target.context);

    const stored = JSON.parse(target.secrets.get(`bunq/${target.context.connectionId}`)!);
    expect(Object.keys(stored).sort()).toEqual([
      'api_key',
      'installation_token',
      'private_key',
      'server_public_key',
    ]);
    expect(stored.api_key).toBe('api-key-from-the-app');
    expect(stored.private_key).toStartWith('-----BEGIN PRIVATE KEY-----');
  });

  test('sends the public key to installation and never the private one', async () => {
    const target = bench(PRODUCTION, 'raw-key');
    await createBunqStrategy(stub(target)).setup!(target.context);

    const sent = JSON.stringify(target.calls);
    expect(JSON.parse(target.calls[0]!.body).client_public_key).toStartWith('-----BEGIN PUBLIC KEY-----');
    expect(sent).not.toContain('BEGIN PRIVATE KEY');
  });

  test('signs device-server and session-server, but not installation', async () => {
    const target = bench(PRODUCTION, 'raw-key');
    await createBunqStrategy(stub(target)).setup!(target.context);

    // Installation cannot be signed: bunq has no key to check it against yet.
    expect(target.calls[0]!.headers.get('x-bunq-client-signature')).toBeNull();
    expect(target.calls[1]!.headers.get('x-bunq-client-signature')).not.toBeNull();
  });

  test('refuses where credentials are not writable, rather than half-installing', async () => {
    const target = bench(PRODUCTION, 'raw-key');
    const context = { ...target.context, write: undefined } as unknown as AuthStrategyContext;

    expect(createBunqStrategy(stub(target)).setup!(context)).rejects.toThrow(/can only be set up/);
  });

  test('re-running on an installed connection reuses the key rather than sending the blob', async () => {
    // The recovery path for a rotated key or a revoked device. The ref already
    // holds the whole context this function wrote last time; reading it as a
    // key would post a JSON blob to /device-server as `secret`.
    const target = bench(PRODUCTION, 'installed');
    await createBunqStrategy(stub(target)).setup!(target.context);

    const device = target.calls.find((c) => c.path.endsWith('/device-server'))!;
    expect(JSON.parse(device.body).secret).toBe('api-key-from-the-app');
  });

  test('a bunq error is passed through with its body, not flattened', async () => {
    const target = bench(PRODUCTION, 'raw-key');
    const failing = (async () =>
      new Response('{"Error":[{"error_description":"Insufficient authorisation"}]}', {
        status: 403,
      })) as unknown as typeof globalThis.fetch;

    expect(createBunqStrategy(failing).setup!(target.context)).rejects.toThrow(
      /answered 403.*Insufficient authorisation/s,
    );
  });
});

describe('authorize', () => {
  test('signs the body and carries the session, verifiably', async () => {
    const target = bench(PRODUCTION);
    const request = await createBunqStrategy(stub(target)).authorize(payment(), target.context);
    const body = await request.clone().text();

    const stored = JSON.parse(target.secrets.get(`bunq/${target.context.connectionId}`)!);
    expect(request.headers.get('x-bunq-client-signature')).toBe(signBody(body, stored.private_key));
    expect(request.headers.get('x-bunq-client-authentication')).toStartWith('session-');
  });

  test('the body survives the rewrite — a signature over a lost body is worthless', async () => {
    const target = bench(PRODUCTION);
    const request = await createBunqStrategy(stub(target)).authorize(payment(), target.context);

    expect(JSON.parse(await request.text())).toEqual({
      amount: { value: '10.00', currency: 'EUR' },
    });
  });

  test('a GET signs the empty string and still sends the header', async () => {
    const target = bench(PRODUCTION);
    const get = new Request('https://api.bunq.com/v1/user');
    const request = await createBunqStrategy(stub(target)).authorize(get, target.context);

    const stored = JSON.parse(target.secrets.get(`bunq/${target.context.connectionId}`)!);
    expect(request.headers.get('x-bunq-client-signature')).toBe(signBody('', stored.private_key));
  });

  test('gives every request its own request id, so a retry is not de-duplicated as the original', async () => {
    const target = bench(PRODUCTION);
    const strategy = createBunqStrategy(stub(target));
    const first = await strategy.authorize(payment(), target.context);
    const second = await strategy.authorize(payment(), target.context);

    expect(first.headers.get('x-bunq-client-request-id')).not.toBe(
      second.headers.get('x-bunq-client-request-id'),
    );
  });

  test('opens one session and reuses it', async () => {
    const target = bench(PRODUCTION);
    const strategy = createBunqStrategy(stub(target));
    await strategy.authorize(payment(), target.context);
    await strategy.authorize(payment(), target.context);

    expect(target.calls.filter((c) => c.path.endsWith('/session-server'))).toHaveLength(1);
  });

  test('two concurrent first calls still open only one session', async () => {
    // `/session-server` allows one call per thirty seconds, so the second of a
    // simultaneous pair would be refused outright.
    const target = bench(PRODUCTION);
    const strategy = createBunqStrategy(stub(target));
    await Promise.all([
      strategy.authorize(payment(), target.context),
      strategy.authorize(payment(), target.context),
    ]);

    expect(target.calls.filter((c) => c.path.endsWith('/session-server'))).toHaveLength(1);
  });

  test('reuses a session another instance persisted, rather than opening its own', async () => {
    const target = bench(PRODUCTION);
    target.state.set(
      'bunq:session',
      JSON.stringify({ token: 'from-another-instance', createdAt: Date.now() }),
    );

    const request = await createBunqStrategy(stub(target)).authorize(payment(), target.context);

    expect(request.headers.get('x-bunq-client-authentication')).toBe('from-another-instance');
    expect(target.calls).toHaveLength(0);
  });

  test('an expired session is replaced', async () => {
    const target = bench(PRODUCTION);
    target.state.set(
      'bunq:session',
      JSON.stringify({ token: 'stale', createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
    );

    const request = await createBunqStrategy(stub(target)).authorize(payment(), target.context);

    expect(request.headers.get('x-bunq-client-authentication')).not.toBe('stale');
  });

  test('a sandbox manifest handshakes and pays against the sandbox', async () => {
    // Both halves from one source. When this was a `sandbox` flag beside
    // `base_url` the two could disagree, and the failure was silent: a session
    // opened against one bunq and spent against the other authenticates
    // cleanly and then answers about an account that does not exist.
    const target = bench(SANDBOX);
    const request = await createBunqStrategy(stub(target)).authorize(payment(SANDBOX), target.context);

    expect(request.url).toStartWith(new URL(SANDBOX).origin);
    expect(target.calls[0]!.url).toBe(`${SANDBOX}/session-server`);
  });

  test('a production manifest stays on production', async () => {
    const target = bench(PRODUCTION);
    const request = await createBunqStrategy(stub(target)).authorize(payment(), target.context);

    expect(request.url).toStartWith(new URL(PRODUCTION).origin);
    expect(target.calls[0]!.url).toBe(`${PRODUCTION}/session-server`);
  });

  test('a connection holding only the pasted key says so, rather than failing upstream', async () => {
    const target = bench(PRODUCTION, 'raw-key');

    expect(
      createBunqStrategy(stub(target)).authorize(payment(), target.context),
    ).rejects.toThrow(/holds an API key but no installation/);
  });

  test('a connection with nothing stored names the command that fixes it', async () => {
    const target = bench(PRODUCTION, 'none');

    expect(createBunqStrategy(stub(target)).authorize(payment(), target.context)).rejects.toThrow(
      /lanes link connect bunq/,
    );
  });
});

describe('two profiles in one process', () => {
  test('do not share a session, even with a connection of the same name', async () => {
    // One endpoint opens a Runtime per profile in the same process. Before the
    // cache key carried the profile, `bunq.main` named both of these — so the
    // second profile would send the first's session token, signed with its own
    // key, to a bank.
    const personal = bench(PRODUCTION, 'installed', 'main', 'personal');
    const work = bench(PRODUCTION, 'installed', 'main', 'work');

    const a = await createBunqStrategy(stub(personal)).authorize(payment(), personal.context);
    const b = await createBunqStrategy(stub(work)).authorize(payment(), work.context);

    expect(a.headers.get('x-bunq-client-authentication')).not.toBe(
      b.headers.get('x-bunq-client-authentication'),
    );
    expect(work.calls.filter((c) => c.path.endsWith('/session-server'))).toHaveLength(1);
  });
});

describe('verify', () => {
  test('a 401 drops the session, so the next call opens a new one', async () => {
    const target = bench(PRODUCTION);
    const strategy = createBunqStrategy(stub(target));

    const first = await strategy.authorize(payment(), target.context);
    await strategy.verify!(new Response(null, { status: 401 }), target.context);
    const second = await strategy.authorize(payment(), target.context);

    expect(target.state.has('bunq:session')).toBe(true); // rewritten, not merely cleared
    expect(second.headers.get('x-bunq-client-authentication')).not.toBe(
      first.headers.get('x-bunq-client-authentication'),
    );
    expect(target.calls.filter((c) => c.path.endsWith('/session-server'))).toHaveLength(2);
  });

  test('an ordinary response with no signature is left alone', async () => {
    const target = bench(PRODUCTION);
    const strategy = createBunqStrategy(stub(target));
    await strategy.authorize(payment(), target.context);

    expect(strategy.verify!(new Response('{}', { status: 200 }), target.context)).resolves.toBeUndefined();
  });

  test('a bad signature is logged, not thrown — the answer has already arrived', async () => {
    const target = bench(PRODUCTION);
    const strategy = createBunqStrategy(stub(target));
    await strategy.authorize(payment(), target.context);

    const errors: string[] = [];
    const context = {
      ...target.context,
      log: { debug() {}, info() {}, warn() {}, error: (m: string) => errors.push(m) },
    } as unknown as AuthStrategyContext;

    await strategy.verify!(
      new Response('{}', { status: 200, headers: { 'x-bunq-server-signature': 'wrong' } }),
      context,
    );

    expect(errors).toEqual(['a bunq response failed signature verification']);
  });
});
