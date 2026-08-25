import type { KeyValueStore } from '#stores/state';

/**
 * What an authorization server has to remember.
 *
 * Three kinds of short-lived record — registered clients, authorization codes,
 * and issued tokens — over the `KeyValueStore` the database already exposes.
 * No new table and no migration, because there are none: the state store is a
 * namespaced key-value store and this is namespaced key-value data.
 *
 * It is genuinely runtime state, which is the rule for anything living here.
 * Deleting a profile's database logs every connector out and they authorise
 * again; nothing about *what should exist* is lost, because a client
 * registration is a fact about a past conversation rather than a declaration.
 *
 * **Tokens are stored hashed.** A bucket listing, a backup, or anyone who can
 * read the objects must not thereby hold a working credential — the same reasoning that makes
 * the profile token a constant-time comparison against a hash rather than a
 * string sitting in a row. Codes are hashed for the same reason and matter less,
 * living about a minute.
 */

const CLIENTS = 'oauth/clients';
const CODES = 'oauth/codes';
const TOKENS = 'oauth/tokens';

/** Far above any real number of connectors, and far below a problem. */
const MAX_CLIENTS = 200;

export interface RegisteredClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName?: string | undefined;
  readonly createdAt: number;
}

export interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The S256 challenge. The verifier never leaves the client. */
  readonly codeChallenge: string;
  readonly scope: string;
  readonly resource?: string | undefined;
  readonly expiresAt: number;
}

/**
 * `consumed` is a spent refresh token kept as a tombstone.
 *
 * Deleting one outright is what made replay undetectable: a token that is
 * simply absent cannot be told apart from one that never existed, so the single
 * signal that a refresh token has been copied was being discarded at the moment
 * it arrived. A tombstone keeps the family id and nothing else useful, and it
 * opens no more than a deleted row does — every check that admits a credential
 * tests for `access` by name.
 *
 * What is *done* about a detected replay changed in ADR-035: the presented
 * token is refused and the replay logged, rather than the family revoked.
 */
export type TokenKind = 'access' | 'refresh' | 'consumed';

export interface IssuedToken {
  readonly clientId: string;
  readonly kind: TokenKind;
  readonly scope: string;
  readonly expiresAt: number;
  /**
   * Which refresh chain this belongs to.
   *
   * Rotation replaces one refresh token with the next, and a client that
   * retries a request it never saw the answer to will present the previous one.
   * Keeping the family lets a replayed token invalidate the whole chain rather
   * than only itself — the standard response to a stolen refresh token, since
   * the theft and the retry look identical from here.
   */
  readonly family: string;
}

export function hashToken(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value, 'utf8').digest('hex');
}

/** 32 random bytes, base64url. The only place a credential is minted here. */
export function randomToken(prefix: string): string {
  return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
}

export class OAuthStore {
  readonly #state: KeyValueStore;
  readonly #now: () => number;

  constructor(state: KeyValueStore, now: () => number = Date.now) {
    this.#state = state;
    this.#now = now;
  }

  async registerClient(client: RegisteredClient): Promise<void> {
    await this.#state.set(CLIENTS, client.clientId, JSON.stringify(client));
    await this.#pruneClients();
  }

  /**
   * Keep the client list bounded.
   *
   * Registration is deliberately open — it yields an identifier and nothing
   * else, and requiring authentication for it would mean the pasted client id
   * this mode exists to avoid. Open does mean an unauthenticated caller can
   * write rows, so the list is capped and the oldest go first.
   *
   * A client holding a live token is never evicted, whatever its age: that is a
   * connector someone is using, and dropping it would log them out to make room
   * for a stranger. The cap is far above any real number of connectors, so in
   * ordinary use this never fires.
   */
  async #pruneClients(): Promise<void> {
    const keys = await this.#state.keys(CLIENTS);
    if (keys.length <= MAX_CLIENTS) return;

    const active = new Set<string>();
    for (const key of await this.#state.keys(TOKENS)) {
      const token = await this.#read<IssuedToken>(TOKENS, key);
      if (token) active.add(token.clientId);
    }

    const evictable: RegisteredClient[] = [];
    for (const key of keys) {
      const client = await this.#read<RegisteredClient>(CLIENTS, key);
      if (client && !active.has(client.clientId)) evictable.push(client);
    }

    evictable.sort((a, b) => a.createdAt - b.createdAt);
    for (const client of evictable.slice(0, keys.length - MAX_CLIENTS)) {
      await this.#state.delete(CLIENTS, client.clientId);
    }
  }

  async client(clientId: string): Promise<RegisteredClient | null> {
    return this.#read<RegisteredClient>(CLIENTS, clientId);
  }

  async putCode(code: string, record: AuthorizationCode): Promise<void> {
    await this.#state.set(CODES, hashToken(code), JSON.stringify(record));
  }

  /**
   * Read a code and consume it in the same step.
   *
   * Single-use is not an optimisation: a code that survives its exchange can be
   * replayed by anyone who reached the redirect — a browser history entry, a
   * proxy log, a referrer header — and PKCE only binds it to the client that
   * started the flow, not to one use.
   */
  async takeCode(code: string): Promise<AuthorizationCode | null> {
    const key = hashToken(code);
    const record = await this.#read<AuthorizationCode>(CODES, key);
    await this.#state.delete(CODES, key);
    return record && record.expiresAt > this.#now() ? record : null;
  }

  async putToken(token: string, record: IssuedToken): Promise<void> {
    await this.#state.set(TOKENS, hashToken(token), JSON.stringify(record));
  }

  async token(token: string): Promise<IssuedToken | null> {
    const key = hashToken(token);
    const record = await this.#read<IssuedToken>(TOKENS, key);
    if (!record) return null;

    if (record.expiresAt <= this.#now()) {
      // Nothing here expires on a timer — there is no sweeper and a single-user
      // endpoint does not need one. Expiry is enforced on read, and the row is
      // dropped when it is noticed so the namespace does not grow forever.
      await this.#state.delete(TOKENS, key);
      return null;
    }
    return record;
  }

  async revokeToken(token: string): Promise<void> {
    await this.#state.delete(TOKENS, hashToken(token));
  }

  /** Spend a refresh token, keeping the tombstone that makes a replay visible. */
  async consumeToken(token: string): Promise<void> {
    const key = hashToken(token);
    const record = await this.#read<IssuedToken>(TOKENS, key);
    if (!record) return;
    await this.#state.set(TOKENS, key, JSON.stringify({ ...record, kind: 'consumed' }));
  }

  /**
   * Drop every token in a refresh family.
   *
   * A replay no longer calls this, and a replay was the only thing that did —
   * see `OAuthServer.#refresh` and ADR-035. Kept because it is the shape a
   * deliberate revocation takes: one authorization's whole chain, dropped on
   * purpose. Nothing in `src/` reaches it today, so read a call site as new
   * policy rather than as the old one returning.
   */
  async revokeFamily(family: string): Promise<void> {
    for (const key of await this.#state.keys(TOKENS)) {
      const record = await this.#read<IssuedToken>(TOKENS, key);
      if (record?.family === family) await this.#state.delete(TOKENS, key);
    }
  }

  async #read<T>(namespace: string, key: string): Promise<T | null> {
    const raw = await this.#state.get(namespace, key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A row that will not parse is a row nothing can use. Treating it as
      // absent fails closed; throwing would take the endpoint down over one
      // corrupt record.
      return null;
    }
  }
}
