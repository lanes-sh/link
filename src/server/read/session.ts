import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mayReach, memberPrincipal } from '#auth';

/**
 * A dashboard session, and the person it belongs to.
 *
 * ADR-063 gave the dashboard a credential that answers *does this browser hold
 * the workspace's pairing token*. That is a question about a secret, not about
 * a person, and it was the only credential left here that never had to say who
 * was holding it — the same gap ADR-068 closed for the static MCP token, still
 * open on the surface that reads and writes the owner's own data.
 *
 * So pairing becomes two steps. The token minted by `lanes link pair` opens one
 * thing: the exchange below. What it buys is a session naming the Lanes subject
 * at the browser, and the profiles that subject's `members:` name back. Every
 * other path takes the session and nothing else.
 *
 * **Why not `OAuthStore`.** It carries `subject` and `profiles` already, and
 * reusing it was the obvious move. It is built from `auth.authorization`, which
 * most workspaces never declare — the dashboard works without one — so the
 * store would be absent exactly where this is needed. A second table over the
 * same KV is smaller than making the first one conditional.
 */

/**
 * The three operations this needs from a key-value store, declared not imported.
 *
 * `server` may not depend on `#stores`, and widening that table for one table
 * would be the wrong direction to resolve it — the same rule `AuditTail` in
 * `./routes.ts` follows, for the same reason. A `RuntimeState`'s `kv` satisfies
 * this structurally, so both binds pass theirs unchanged.
 */
export interface SessionStore {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
}

/** Who is at the browser, once a session has been resolved. */
export interface PairedCaller {
  /** The Lanes subject, as `members:` spells it. */
  readonly subject: string;
  /** The profiles naming that subject. Empty is a real answer, and means nothing. */
  readonly profiles: readonly string[];
}

/** Namespaces, kept apart so a nonce can never be presented as a session. */
const SESSION_NS = 'read.session';
const NONCE_NS = 'read.nonce';

/**
 * How long a dashboard session lasts.
 *
 * Twelve hours: long enough that somebody working through a day does not
 * re-pair, short enough that removing them from a profile takes effect the same
 * day without an explicit revoke. `profile members remove` still does not end a
 * live session — the same window ADR-060 states for an OAuth token — and this
 * is the ceiling on it.
 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** A challenge is one round trip's worth, like the assertion it asks for. */
const NONCE_TTL_MS = 2 * 60 * 1000;

interface StoredSession {
  readonly subject: string;
  readonly profiles: readonly string[];
  readonly expiresAt: number;
}

interface StoredNonce {
  readonly expiresAt: number;
}

/**
 * Hashed, never stored whole.
 *
 * The KV behind this is the workspace's own state store, which on a deployed
 * workspace is a bucket the revision can read. A session token kept verbatim
 * there would be a live credential sitting in the blob store beside the data it
 * opens; a hash is not one.
 */
function fingerprint(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time, after a length check, for the same reason `credential.ts` is. */
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The prefix a dashboard session carries.
 *
 * Distinct from the pairing token's so the two are never confused for one
 * another in a log, a bug report, or a `grep`. It is not a security boundary:
 * the store decides, and a token of the wrong shape simply misses.
 */
export const SESSION_PREFIX = 'llps_';

export interface PairingSessions {
  /** A nonce for one assertion, remembered so it can be spent exactly once. */
  challenge(): Promise<string>;
  /** Spend a nonce. False for one that was never minted, has expired, or is spent. */
  spend(nonce: string): Promise<boolean>;
  /** Mint a session for a subject whose assertion has been verified. */
  open(caller: PairedCaller): Promise<{ token: string; expiresAt: number }>;
  /** Resolve a presented session token, or null. */
  resolve(presented: string): Promise<PairedCaller | null>;
  /** End one session. What signing out of the dashboard does. */
  close(presented: string): Promise<void>;
}

export function pairingSessions(
  kv: SessionStore,
  options: { readonly now?: () => number; readonly ttlMs?: number } = {},
): PairingSessions {
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? SESSION_TTL_MS;

  return {
    async challenge() {
      const nonce = randomBytes(24).toString('base64url');
      const record: StoredNonce = { expiresAt: now() + NONCE_TTL_MS };
      await kv.set(NONCE_NS, fingerprint(nonce), JSON.stringify(record));
      return nonce;
    },

    async spend(nonce) {
      const key = fingerprint(nonce);
      const raw = await kv.get(NONCE_NS, key);
      if (raw === null) return false;

      // Spent whether or not it was still valid. A nonce that has been
      // presented once is finished, and leaving an expired one in place would
      // let a slow replay keep trying against a row that never goes away.
      await kv.delete(NONCE_NS, key);

      try {
        return (JSON.parse(raw) as StoredNonce).expiresAt > now();
      } catch {
        return false;
      }
    },

    async open(caller) {
      const token = `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
      const expiresAt = now() + ttl;
      const record: StoredSession = {
        subject: caller.subject,
        profiles: caller.profiles,
        expiresAt,
      };
      await kv.set(SESSION_NS, fingerprint(token), JSON.stringify(record));
      return { token, expiresAt };
    },

    async resolve(presented) {
      if (!presented.startsWith(SESSION_PREFIX)) return null;

      const key = fingerprint(presented);
      const raw = await kv.get(SESSION_NS, key);
      if (raw === null) return null;

      let record: StoredSession;
      try {
        record = JSON.parse(raw) as StoredSession;
      } catch {
        return null;
      }

      if (record.expiresAt <= now()) {
        await kv.delete(SESSION_NS, key);
        return null;
      }

      // The hash is what was looked up, so this cannot mismatch. It is here
      // because a store that ever returned a row for a near-miss key would
      // otherwise hand back somebody else's session, and the check costs
      // nothing next to the read that preceded it.
      if (!matches(key, fingerprint(presented))) return null;

      return { subject: record.subject, profiles: record.profiles };
    },

    async close(presented) {
      if (!presented.startsWith(SESSION_PREFIX)) return;
      await kv.delete(SESSION_NS, fingerprint(presented));
    },
  };
}

/**
 * Whether this caller may reach a profile.
 *
 * Routed through `mayReach` rather than testing the array here, so the
 * dashboard and the dispatcher answer the question with the same function. A
 * second implementation would be a second answer, and the one that drifted
 * would be the one nobody was reading.
 */
export function reaches(caller: PairedCaller, profile: string): boolean {
  return mayReach(memberPrincipal(caller.subject, profile, caller.profiles), profile);
}
