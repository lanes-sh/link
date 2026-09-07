import { describe, expect, test } from 'bun:test';
import { workspaceVaultKey } from '#secrets';
import { controlRoutes } from './routes.ts';
import { workspaceRootFor } from './authorise.ts';
import { environmentFor } from './workspace.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * The test ADR-070 asks for: two workspaces in one process cannot reach each
 * other.
 *
 * One process serving many tenants is where an isolation bug stops being a bug
 * and becomes somebody else's mail. Three things had to hold and only one of
 * them did:
 *
 * 1. **Different vault keys.** Did not hold. `LANES_LINK_VAULT_KEY` was read
 *    once for the process, so every tenant's vault was sealed under one key.
 * 2. **Different credential namespaces.** Held already — `encodeRef` takes a
 *    namespace and `target-managed.test.ts` pins it.
 * 3. **Different roots, from the assertion and nothing else.** Held already,
 *    and `workspaceRootFor` takes one argument so a second cannot be added
 *    quietly.
 *
 * The assertions are written so that a regression in any of the three fails
 * here rather than in a support conversation.
 */

const MASTER = { LANES_LINK_VAULT_KEY: Buffer.alloc(32, 3).toString('base64') };

const assertionFor = (workspace: string): ControlAssertion => ({
  subject: 'lanes:abc123',
  workspace,
  role: 'admin',
  scopes: ['link:admin'],
});

describe('two workspaces sharing one process', () => {
  test('seal their vaults under different keys', async () => {
    const mine = await workspaceVaultKey('ws-aaa', MASTER)();
    const theirs = await workspaceVaultKey('ws-bbb', MASTER)();

    expect(Buffer.from(mine).toString('hex')).not.toBe(Buffer.from(theirs).toString('hex'));
  });

  test('address different roots, derived from the assertion alone', () => {
    expect(workspaceRootFor(assertionFor('ws-aaa'))).toBe('lanes://ws-aaa');
    expect(workspaceRootFor(assertionFor('ws-bbb'))).toBe('lanes://ws-bbb');

    // The invariant that keeps a request body from ever naming a workspace. If
    // this arity changes, somebody has added a way to ask for another tenant.
    expect(workspaceRootFor.length).toBe(1);
  });

  test('give their commands different homes', () => {
    // `environmentFor` is what a command reads instead of `process.env`, which
    // one process serving many workspaces cannot use. Two assertions must not
    // produce one home.
    const mine = environmentFor(assertionFor('ws-aaa'));
    const theirs = environmentFor(assertionFor('ws-bbb'));

    expect(mine['LANES_LINK_HOME']).toBe('lanes://ws-aaa');
    expect(theirs['LANES_LINK_HOME']).toBe('lanes://ws-bbb');
    // And neither leaked into the process's own environment on the way.
    expect(process.env['LANES_LINK_HOME']).not.toBe('lanes://ws-aaa');
  });
});

describe('an assertion for one workspace arriving at another', () => {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };

  /** Routed as `dispatchedFor`, asserting `asserted`. */
  const call = async (dispatchedFor: string, asserted: string): Promise<Response> =>
    controlRoutes(
      new Request('https://runtime.example.com/v1/profiles', {
        headers: { authorization: 'Bearer a.b.c' },
      }),
      {
        workspace: dispatchedFor,
        verifier: { async verify() { return assertionFor(asserted); } },
        log: silent,
        ensure: async () => false,
        readers: {
          async connections() { return []; },
          async profiles() { return { profiles: [{ name: 'personal', grants: 1, members: 1 }], unreadable: [] }; },
        },
      },
    );

  test('is refused, and refused as an unknown path', async () => {
    const crossed = await call('ws-bbb', 'ws-aaa');

    // 404 rather than 403: which of the two failed is the log's business. A
    // caller told "that assertion is for another workspace" learns that this
    // one exists and that theirs is real, which is two facts more than a
    // refusal owes anybody.
    expect(crossed.status).toBe(404);
  });

  test('and the same call agreeing is served, so the test is not vacuous', async () => {
    const agreed = await call('ws-aaa', 'ws-aaa');

    expect(agreed.status).toBe(200);
    expect(((await agreed.json()) as { workspace: string }).workspace).toBe('ws-aaa');
  });
});
