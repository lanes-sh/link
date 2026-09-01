import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a presented credential is this workspace's pairing token.
 *
 * A verifier rather than the token itself, because the two binds pay very
 * different prices for the answer and only the verifier can know that. On
 * loopback the credential store holds a decrypted copy and a read is a map
 * lookup; on a deployed workspace `GcpSecretManagerStore` has no cache at all
 * and every `get()` is a network round trip. A shared `token: () => Promise`
 * thunk hid that difference behind one signature, and the comment that used to
 * sit above it — "this is a map lookup in the ordinary case" — was true of one
 * store and false of the other.
 */
export interface PairingCredential {
  /** Never throws. A store that failed is a refusal, not a `500`. */
  verify(presented: string): Promise<boolean>;
}

/**
 * Constant-time, after a length check.
 *
 * The length is compared first and separately because `timingSafeEqual` throws
 * on a mismatch rather than returning false. The length of a token is not the
 * secret; its contents are.
 */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CredentialSource {
  /** `null` for a secret that exists with no version — the never-paired case. */
  readonly read: () => Promise<string | null>;
  /** Drops a cached decrypted copy, because the rotation was written elsewhere. */
  readonly refresh?: (() => void) | undefined;
  /** Why a read failed, for an operator. Never the credential itself. */
  readonly onError?: ((reason: string) => void) | undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loopback: read on every presentation, so a rotation lands immediately.
 *
 * `pair --rotate` says "the previous pairing link no longer works", and captured
 * at boot that was false — the live listener went on accepting the old token
 * until the endpoint restarted. Reading per request is what makes the command
 * tell the truth, and it is affordable here because the store is a local file.
 */
export function directPairingCredential(source: CredentialSource): PairingCredential {
  return {
    async verify(presented) {
      try {
        source.refresh?.();
        const expected = await source.read();
        return expected !== null && expected !== '' && matches(presented, expected);
      } catch (error) {
        source.onError?.(reasonOf(error));
        return false;
      }
    },
  };
}

/** How long a deployed endpoint may keep an answer. Matches the bearer's own window. */
const CACHE_TTL_MS = 5_000;

/**
 * Deployed: one cached read, and a mismatch buys exactly one more.
 *
 * The same trade `BearerAuthenticator` already takes for the MCP bearer, over a
 * strictly weaker credential and with the same five seconds. Without it a
 * dashboard polling `/state` is one Secret Manager call per poll for as long as
 * the page is open, and a stranger sending a wrong token is one call per
 * request — which is the ADR-054 hazard in its purest form, a costly read
 * performed on behalf of a caller who has presented nothing valid.
 *
 * What the re-read on mismatch preserves is the property that mattered: a
 * token rotated *in* works on its first presentation, because a mismatch
 * against a cached value is ambiguous and exactly one re-read separates
 * "rotated" from "wrong". What it costs is that a token rotated *away* keeps
 * reading for up to the window rather than stopping at once — bounded, where
 * the failure `open.ts` records was unbounded until a restart.
 */
export function cachedPairingCredential(
  source: CredentialSource & { readonly ttlMs?: number; readonly now?: () => number },
): PairingCredential {
  const ttl = source.ttlMs ?? CACHE_TTL_MS;
  const now = source.now ?? (() => Date.now());

  let cached: string | null = null;
  // Both start "infinitely stale", so the first call reads and the first
  // mismatch is always given its one re-read.
  let readAt = -Infinity;
  let missAt = -Infinity;

  const reread = async (): Promise<void> => {
    source.refresh?.();
    cached = await source.read();
    readAt = now();
  };

  const hit = (presented: string): boolean =>
    cached !== null && cached !== '' && matches(presented, cached);

  return {
    async verify(presented) {
      try {
        if (now() - readAt >= ttl) await reread();
        if (hit(presented)) return true;

        // A miss against a cached value is ambiguous: the token may be wrong,
        // or it may be the one a rotation has just written. One re-read tells
        // them apart — and **one per window**, tracked separately from the
        // ordinary refresh above. Keying it on `readAt` instead meant the
        // re-read refreshed the very clock that decided whether to re-read, so
        // every wrong guess bought its own Secret Manager call and the ceiling
        // this cache exists to impose was not there at all.
        if (now() - missAt < ttl) return false;
        missAt = now();
        await reread();

        return hit(presented);
      } catch (error) {
        source.onError?.(reasonOf(error));
        return false;
      }
    },
  };
}
