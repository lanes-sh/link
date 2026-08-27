import { signBody } from './keys.ts';

/**
 * bunq's three-step API context, which is why this provider needs code at all.
 *
 * Most APIs take a key and are done. bunq takes a key and then wants an
 * *installation* (here is my public key), a *device* (this key may be used, from
 * these addresses), and a *session* (and now let me in) — three round trips
 * producing three different tokens, of which only the last one authenticates an
 * ordinary call. No manifest field describes that, which is the whole argument
 * for `AuthStrategy` in ADR-008.
 *
 * Nothing in this file names an operation. It knows how to open a session and
 * nothing about what the session is then used for.
 */

export const PRODUCTION = 'https://api.bunq.com/v1';
export const SANDBOX = 'https://public-api.sandbox.bunq.com/v1';

/**
 * Which bunq this connection talks to: whatever its manifest says.
 *
 * One provider serves both environments, because they are the same API and the
 * same tool list — a second provider id would duplicate the manifest, the
 * vendored spec, and every policy rule written against it. The built-in names
 * production; a workspace manifest in `providers.d/` naming the sandbox gets
 * the sandbox, and borrows this strategy through `strategyFor`.
 *
 * This used to be a `sandbox: true` option on the strategy, with `authorize`
 * rewriting the request origin to match. That was a second source of truth for
 * something `base_url` already states, and the two could disagree — a manifest
 * pointed at the sandbox but missing the flag (or carrying `sandbox: "true"`,
 * which is not `true`) would have spent against production while its own
 * `base_url` said otherwise. Reading the manifest makes the disagreement
 * impossible rather than documented, and the transport and the handshake now
 * cannot end up on different hosts because neither chooses.
 */
export function hostFor(manifest: { connector: { kind: string } }): string {
  const connector = manifest.connector as { kind: string; base_url?: string };
  if (connector.kind !== 'http' || !connector.base_url) {
    throw new Error('The bunq strategy needs an http connector with a base_url.');
  }

  return connector.base_url.replace(/\/$/, '');
}

export interface Installation {
  /** Authenticates device-server and session-server, and nothing else. */
  readonly token: string;
  /** bunq's half, for checking that a reply is bunq's. */
  readonly serverPublicKey: string;
}

/**
 * Everything bunq requires on a request that is not the signature.
 *
 * `X-Bunq-Client-Request-Id` must differ per request; bunq uses it to
 * de-duplicate, so reusing one would make a retried payment silently a no-op —
 * which is the behaviour you want, but only if the id is genuinely fresh when
 * the payment is genuinely new.
 */
export function baseHeaders(): Record<string, string> {
  return {
    // No `content-type`. Every handshake call below adds it because every one
    // of them posts JSON, but `authorize` applies this set to reads too, and a
    // GET that carries no body should not claim one.
    'cache-control': 'no-cache',
    'user-agent': 'lanes-link/1.0',
    'x-bunq-language': 'en_US',
    'x-bunq-region': 'en_US',
    'x-bunq-geolocation': '0 0 0 0 000',
    'x-bunq-client-request-id': crypto.randomUUID(),
  };
}

/**
 * bunq answers everything as `{ Response: [ { Key: value }, … ] }`.
 *
 * An array of single-key objects rather than one object, so reading a field
 * means searching for the wrapper that holds it.
 */
function pick(payload: unknown, wrapper: string): Record<string, unknown> | undefined {
  const entries = (payload as { Response?: unknown[] } | null)?.Response;
  if (!Array.isArray(entries)) return undefined;

  for (const entry of entries) {
    const found = (entry as Record<string, unknown>)?.[wrapper];
    if (found && typeof found === 'object') return found as Record<string, unknown>;
  }

  return undefined;
}

async function call(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  fetcher: typeof globalThis.fetch,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  const response = await fetcher(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: payload,
  });
  const text = await response.text();

  if (!response.ok) {
    // bunq's errors are readable and specific — a wrong key, an IP that is not
    // permitted, a session created too soon. Passing the text through is what
    // makes the difference visible; swallowing it leaves "connect failed".
    throw new Error(`bunq ${new URL(url).pathname} answered ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

/**
 * Step one: hand bunq the public key. The only call needing no authentication
 * and no signature, because bunq has nothing to check one against yet.
 */
export async function createInstallation(
  host: string,
  publicKey: string,
  fetcher: typeof globalThis.fetch,
): Promise<Installation> {
  const payload = await call(
    `${host}/installation`,
    { client_public_key: publicKey },
    baseHeaders(),
    fetcher,
  );

  const token = pick(payload, 'Token')?.['token'];
  const serverPublicKey = pick(payload, 'ServerPublicKey')?.['server_public_key'];

  if (typeof token !== 'string' || typeof serverPublicKey !== 'string') {
    throw new Error('bunq /installation returned no token or no server public key.');
  }

  return { token, serverPublicKey };
}

/**
 * Step two: register the key against the addresses it may be used from.
 *
 * `permitted_ips` is deliberately not passed. bunq refuses the wildcard `*` over
 * the API — it can only be set in the app — and any list written here would be
 * this machine's address at connect time, which is wrong the moment the
 * endpoint is deployed or the operator's ISP renumbers. Omitting it lets bunq
 * default to the calling address, and the setup doc says plainly that a
 * deployment needs a key marked wildcard in the app.
 *
 * Idempotent in practice: re-registering an existing device answers 200.
 */
export async function registerDevice(
  host: string,
  installationToken: string,
  apiKey: string,
  description: string,
  privateKey: string,
  fetcher: typeof globalThis.fetch,
): Promise<void> {
  const body = { secret: apiKey, description };

  await call(
    `${host}/device-server`,
    body,
    {
      ...baseHeaders(),
      'x-bunq-client-authentication': installationToken,
      'x-bunq-client-signature': signBody(JSON.stringify(body), privateKey),
    },
    fetcher,
  );
}

/**
 * Step three, and the only one that runs again later.
 *
 * A session lasts as long as the account's auto-logout setting — a week by
 * default — and `/session-server` is rate-limited to **one call per thirty
 * seconds**. That limit is the reason the token is persisted in shared state
 * rather than held per instance: a deployed endpoint that opened a session per
 * cold start would spend most of its life being refused.
 */
export async function createSession(
  host: string,
  installationToken: string,
  apiKey: string,
  privateKey: string,
  fetcher: typeof globalThis.fetch,
): Promise<string> {
  const body = { secret: apiKey };

  const payload = await call(
    `${host}/session-server`,
    body,
    {
      ...baseHeaders(),
      'x-bunq-client-authentication': installationToken,
      'x-bunq-client-signature': signBody(JSON.stringify(body), privateKey),
    },
    fetcher,
  );

  const token = pick(payload, 'Token')?.['token'];
  if (typeof token !== 'string') throw new Error('bunq /session-server returned no token.');

  return token;
}
