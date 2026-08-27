import type { AuthStrategy, AuthStrategyContext } from '#connectivity';
import { createInstallation, createSession, hostFor, registerDevice, baseHeaders } from './handshake.ts';
import { generateKeypair, signBody, verifyBody } from './keys.ts';

/**
 * bunq, whose authentication is a protocol rather than a header.
 *
 * The one strategy, and the case ADR-008 was written around. Everything else
 * about this provider is declared — the connector, the vendored operations, the
 * redaction — and this file only ever sees a request on its way out and a
 * response on its way back. It contains no endpoint knowledge and must not gain
 * any.
 *
 * Three durable things come out of `setup` and live in the credential store:
 * the private key, the installation token, and bunq's own public key. One
 * ephemeral thing comes out of every session and lives in `state`: the session
 * token. The split is forced rather than chosen — `AuthStrategyContext.write`
 * is absent outside setup, and `rotatableCredentialRefs` grants a deployed
 * revision write on nothing for a non-OAuth provider, so a session token
 * physically cannot go in the credential store. `state` is the right home
 * anyway: it is documented for exactly this, and everything in it is
 * reconstructible from the API key.
 */

/** Where the whole credential lives. Derived per connection: `bunq/<id>`. */
interface Stored {
  readonly api_key: string;
  readonly private_key: string;
  readonly installation_token: string;
  readonly server_public_key: string;
}

const SESSION_KEY = 'bunq:session';

/**
 * When to open a new session before bunq closes the old one.
 *
 * bunq expires a session after the account's auto-logout setting, a week by
 * default, and there is no endpoint that reports what that setting is. Six days
 * is under the default with room to spare; an operator who shortened theirs is
 * covered by the other half — `verify` clears the session on a 401, so the call
 * after a surprise expiry succeeds. Costing one failed call is the honest
 * trade against guessing a number we cannot read.
 */
const SESSION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

interface Session {
  readonly token: string;
  readonly createdAt: number;
}

/**
 * One cache and one in-flight map, per process.
 *
 * The cache spares a state read per request. The in-flight map is the one that
 * matters: `/session-server` allows **one call per thirty seconds**, so two
 * concurrent requests both finding no session would make the second fail. They
 * wait on the first instead.
 *
 * Keyed by **profile** as well as provider and connection, and that is not
 * belt-and-braces. One endpoint process opens a `Runtime` per profile in the
 * workspace, so `bunq.main` names two different bank accounts as soon as two
 * profiles each connect bunq without renaming the connection. `state` and
 * `credentials` are already scoped per profile; a process-wide cache in front
 * of them is the one place that scoping could be lost, and losing it would send
 * one profile's session token — signed with the other's key — to a bank.
 */
const cached = new Map<string, Session>();
const opening = new Map<string, Promise<string>>();

/** Unique across everything that could hold a different bunq session. */
const cacheKey = (context: AuthStrategyContext): string =>
  `${context.profile}.${context.manifest.id}.${context.connectionId}`;

function parse(raw: string | null, connectionId: string): Stored {
  if (!raw) {
    throw new Error(
      `No bunq credential stored for connection "${connectionId}". Run: lanes link connect bunq`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // The API key as pasted, before `setup` has replaced it with the whole
    // context. A connection in this state has not completed the handshake.
    throw new Error(
      `The bunq connection "${connectionId}" holds an API key but no installation. Run: lanes link connect bunq --replace`,
    );
  }

  const stored = value as Partial<Stored>;
  if (!stored.api_key || !stored.private_key || !stored.installation_token) {
    throw new Error(`The bunq credential for "${connectionId}" is incomplete. Run: lanes link connect bunq --replace`);
  }

  return stored as Stored;
}

/**
 * The API key, whether the ref holds one or a whole installed context.
 *
 * Re-running `connect` on an installed connection is the ordinary way to
 * recover from a rotated key or a revoked device, so it has to be the same
 * conversation as the first run rather than a different failure.
 */
function apiKeyFrom(raw: string): string {
  if (!raw.startsWith('{')) return raw;

  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.api_key === 'string' && parsed.api_key.length > 0) return parsed.api_key;
  } catch {
    // Not JSON after all — a key that happens to start with a brace.
  }

  return raw;
}

async function sessionToken(
  context: AuthStrategyContext,
  stored: Stored,
  fetcher: typeof globalThis.fetch,
): Promise<string> {
  const key = cacheKey(context);
  const fresh = (session: Session | null): boolean =>
    session !== null && Date.now() - session.createdAt < SESSION_MAX_AGE_MS;

  const memo = cached.get(key) ?? null;
  if (fresh(memo)) return memo!.token;

  const persisted = await context.state.getJson<Session>(SESSION_KEY);
  if (fresh(persisted)) {
    cached.set(key, persisted!);
    return persisted!.token;
  }

  const already = opening.get(key);
  if (already) return already;

  const attempt = (async () => {
    context.log.debug('opening a bunq session');
    const token = await createSession(
      hostFor(context.manifest),
      stored.installation_token,
      stored.api_key,
      stored.private_key,
      fetcher,
    );
    const session: Session = { token, createdAt: Date.now() };
    cached.set(key, session);
    await context.state.setJson(SESSION_KEY, session);
    return token;
  })().finally(() => opening.delete(key));

  opening.set(key, attempt);
  return attempt;
}

export function createBunqStrategy(fetcher: typeof globalThis.fetch = globalThis.fetch): AuthStrategy {
  return {
    id: 'bunq',

    /**
     * Installation and device registration, run once at connect time.
     *
     * Ends by rewriting the credential the operator pasted: it arrives as a
     * bare API key and leaves as the whole context. That keeps everything
     * durable behind the single ref a connection is allowed to read, rather
     * than inventing three more the allowlist would refuse.
     *
     * Deliberately stops short of opening a session, though it easily could and
     * an earlier draft did. Two reasons, both about *when* this runs. `connect`
     * performs the handshake under a provisional connection id and renames the
     * connection afterwards — the credential moves with it, but state does not,
     * so a session opened here would be stranded under `bunq.pending`. And
     * `/session-server` allows one call per thirty seconds, so a stranded
     * session is not merely wasted: it is thirty seconds during which the first
     * real call is refused. The key is already proven by `device-server`, which
     * is the step that rejects a wrong one.
     */
    async setup(context) {
      const write = context.write;
      if (!write) throw new Error('The bunq strategy can only be set up where credentials are writable.');

      const ref = `${context.manifest.id}/${context.connectionId}`;
      const held = (await context.credentials.get(ref))?.trim();
      if (!held) throw new Error(`No bunq API key was stored at ${ref}.`);

      // What is at the ref depends on whether this connection has been set up
      // before. First time it is the key the operator pasted; on a re-connect
      // it is the whole context this function wrote last time. Reading it as a
      // key either way would send a JSON blob to `/device-server` as `secret`,
      // and bunq would reject it with a wrong-key error naming nothing the
      // operator did.
      const apiKey = apiKeyFrom(held);

      const host = hostFor(context.manifest);
      const keys = generateKeypair();

      const installation = await createInstallation(host, keys.publicKey, fetcher);
      await registerDevice(
        host,
        installation.token,
        apiKey,
        String(context.options['description'] ?? 'Lanes Link'),
        keys.privateKey,
        fetcher,
      );

      const installed: Stored = {
        api_key: apiKey,
        private_key: keys.privateKey,
        installation_token: installation.token,
        server_public_key: installation.serverPublicKey,
      };
      await write(ref, JSON.stringify(installed));
    },

    async authorize(request, context) {
      const stored = parse(
        await context.credentials.get(`${context.manifest.id}/${context.connectionId}`),
        context.connectionId,
      );

      const token = await sessionToken(context, stored, fetcher);
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();

      // The URL is left exactly as the transport built it. It comes from the
      // manifest's `base_url`, which is also where the handshake got its host,
      // so there is nothing here that could put the two on different bunqs.
      const authorised = new Request(request.url, {
        method: request.method,
        headers: new Headers(request.headers),
        ...(body === '' ? {} : { body }),
        signal: request.signal,
      });

      for (const [key, value] of Object.entries(baseHeaders())) {
        // Never overwrite what the transport set from the operation itself.
        if (!authorised.headers.has(key)) authorised.headers.set(key, value);
      }
      authorised.headers.set('x-bunq-client-authentication', token);
      authorised.headers.set('x-bunq-client-signature', signBody(body, stored.private_key));

      return authorised;
    },

    /**
     * Two jobs, and the second is why this hook is wired at all.
     *
     * A 401 means the session went away earlier than the age check expected —
     * an operator with a short auto-logout, or a session ended from the app.
     * Dropping the cached token here is what makes the *next* call work without
     * anyone intervening.
     *
     * The first job is the one bunq documents: the reply carries a signature
     * over its body, and checking it against the key installation returned is
     * how we know the answer came from bunq. A failure is logged rather than
     * thrown — the response has already been received, the check is documented
     * as optional, and turning a delivered answer into an exception would make
     * a payment that *did* happen look like one that did not.
     */
    async verify(response, context) {
      const key = cacheKey(context);

      if (response.status === 401) {
        cached.delete(key);
        await context.state.delete(SESSION_KEY);
        context.log.warn('bunq rejected the session; the next call will open a new one');
        return;
      }

      // bunq signs its replies but does not promise to sign every one, and the
      // documentation calls checking them optional. An absent header is
      // therefore not a failure; a present one that does not verify is.
      const signature = response.headers.get('x-bunq-server-signature');
      if (!signature) return;

      const raw = await context.credentials.get(`${context.manifest.id}/${context.connectionId}`);
      let publicKey: string | undefined;
      try {
        publicKey = raw ? (JSON.parse(raw) as Partial<Stored>).server_public_key : undefined;
      } catch {
        // A connection still holding the bare pasted key. `authorize` has
        // already refused it with a message that says what to do, and repeating
        // that here would replace it with a parse error.
        return;
      }
      if (!publicKey) return;

      if (!verifyBody(await response.text(), signature, publicKey)) {
        context.log.error('a bunq response failed signature verification');
      }
    },
  };
}
