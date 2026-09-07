import { afterAll, describe, expect, test } from 'bun:test';
import { allocatePort, rpc, startHarness } from './harness.ts';

/**
 * What this endpoint tells a client about caching its lists.
 *
 * ADR-032 declared `listChanged: false` so that a client has no reason to trust
 * a cached tool list, and said plainly that nothing here can *make* one
 * re-read. The 2026-07-28 revision turned the first half of that into a field:
 * `tools/list` results carry `ttlMs` and `cacheScope` (SEP-2549), a server
 * **MUST** include them, and `ttlMs: 0` means "immediately stale; the client MAY
 * re-fetch every time the result is needed". That is ADR-032's sentence, said
 * normatively instead of by implication.
 *
 * Nothing in `src/` sets these. `@modelcontextprotocol/server` fills them at its
 * encode seam from the conservative defaults `{ ttlMs: 0, cacheScope: 'private'
 * }`, which happen to be exactly what this endpoint wants — so the behaviour is
 * correct and is resting entirely on somebody else's default. This is the test
 * that makes it ours.
 *
 * Two ways it could go wrong, and neither would fail anything else:
 *
 * **A positive `ttlMs`** would re-create ADR-032's failure with the endpoint's
 * own cooperation. That ADR exists because a client held two setup tools for as
 * long as it lived while the endpoint served forty-two; a `ttlMs` of minutes
 * would tell a *conformant* client to do the same thing on purpose.
 *
 * **`cacheScope: 'public'`** would be worse than stale, and is the reason this
 * asserts a field nobody set. The spec's own security note is that a `public`
 * response "may be shared outside of the initial request's authorization
 * context (i.e. different access tokens can leverage the same cache)" — and this
 * endpoint's tool list is per principal by construction. `mergeCapabilities`
 * filters on `mayReach` and `allowedConnections`, and ADR-060 keeps a profile a
 * member is not on out of the `profile` enum specifically so they "never learn
 * it exists". Serving that list to another token from a shared cache would leak
 * the set of profiles and accounts a person can reach, which is the one thing
 * the enum is shaped to withhold.
 *
 * So `private` here is a correctness property of the surface rather than a
 * caching preference, and the spec is explicit that `cacheScope` is not an
 * access control on its own.
 */

const listing = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"`,
});

afterAll(async () => {
  await listing.stop();
});

/** The cacheable-result fields, as they arrive on the wire. */
async function hints(method: string): Promise<Record<string, unknown>> {
  const response = await rpc(listing.server.url, method, {});
  expect(response.status).toBe(200);
  return (response.body['result'] ?? {}) as Record<string, unknown>;
}

describe('cacheable list results', () => {
  /**
   * `tools/list` is the one that matters. It is the list ADR-032 is about, and
   * the only one whose staleness has cost a working connector.
   */
  test('tools/list is immediately stale and privately scoped', async () => {
    const result = await hints('tools/list');

    expect(result['ttlMs']).toBe(0);
    expect(result['cacheScope']).toBe('private');
  });

  /**
   * `resources/list` gets the same answer for the same reason, and is asserted
   * separately because it is reached by a different handler: `lanes://instructions`
   * is registered unconditionally, so this list is never empty and the
   * capability is always declared.
   */
  test('resources/list is immediately stale and privately scoped', async () => {
    const result = await hints('resources/list');

    expect(result['ttlMs']).toBe(0);
    expect(result['cacheScope']).toBe('private');
  });

  /**
   * The stamp that says the result is cacheable at all.
   *
   * `resultType: 'complete'` is what carries the hints — an interim
   * `input_required` result under the multi round-trip mechanism is explicitly
   * not cacheable and carries none. Asserting it here means a future change that
   * starts answering a list with an interim result cannot quietly drop the two
   * fields above and still pass.
   */
  test('a list result is a complete result', async () => {
    expect((await hints('tools/list'))['resultType']).toBe('complete');
  });
});
