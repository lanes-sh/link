import type { PairedCaller, PairingSessions } from './session.ts';

/**
 * A pairing session that answers for one token.
 *
 * The routes take a `PairingSessions` so that who is calling is an input rather
 * than something they work out, and a test about filtering wants to state the
 * caller in one line rather than drive the exchange to get one. The real store
 * is exercised in `./session.test.ts`; this stands in for it everywhere the
 * subject under test is a route.
 *
 * `challenge` and `spend` are a matched pair here rather than a store: any
 * nonce this hands out is accepted exactly once, which is the property the
 * exchange depends on and enough for a test that is not about nonces.
 */
export function fixedSessions(token: string, caller: PairedCaller): PairingSessions {
  const live = new Set<string>();
  let issued = 0;

  return {
    async challenge() {
      const nonce = `nonce-${(issued += 1)}`;
      live.add(nonce);
      return nonce;
    },
    async spend(nonce) {
      return live.delete(nonce);
    },
    async open() {
      // One token, whoever it was opened for. A test that cares which subject a
      // session names states it in `caller` above rather than reading it back.
      return { token, expiresAt: Date.now() + 60_000 };
    },
    async resolve(presented) {
      return presented === token ? caller : null;
    },
    async close() {},
  };
}
