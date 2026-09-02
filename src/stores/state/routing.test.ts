import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '../blobs/testing.ts';
import {
  CONNECTIONS_NAMESPACE,
  createRuntimeState,
  DISCOVERY_NAMESPACE,
  isWorkspaceNamespace,
  OAUTH_NAMESPACE,
} from './index.ts';

/**
 * Which store a namespace routes to — the rule ADR-066 turns on.
 *
 * This had no test, and that is how the endpoint's own OAuth state came to be
 * written into one profile's directory: `auth/oauth/store.ts` spelled
 * `oauth/clients` while the constant said `oauth.v1`, so the live namespace was
 * not a workspace one and nothing noticed. Every other test passes one store
 * twice, where the split is unobservable.
 *
 * So these assert the pairing rather than the strings: the namespace each
 * consumer actually uses, against the routing that decides where it lands.
 */

describe('what belongs to the workspace', () => {
  test('the three the whole endpoint shares', () => {
    // A `connect` run once must read as connected from every profile; the
    // discovery cache is a fact about a provider; and the OAuth server is the
    // endpoint's, not a profile's.
    expect(isWorkspaceNamespace(CONNECTIONS_NAMESPACE)).toBe(true);
    expect(isWorkspaceNamespace(DISCOVERY_NAMESPACE)).toBe(true);
    expect(isWorkspaceNamespace(OAUTH_NAMESPACE)).toBe(true);
  });

  test("the OAuth server's own sub-namespaces, as it actually spells them", async () => {
    // The pairing that was broken. Read off the module rather than retyped, so
    // a rename there cannot pass here and fail in production.
    const { OAUTH_SUBSPACES } = await import('#auth/oauth/store.ts');

    expect(OAUTH_SUBSPACES.length).toBeGreaterThan(0);
    for (const namespace of OAUTH_SUBSPACES) {
      expect({ namespace, workspace: isWorkspaceNamespace(namespace) }).toEqual({
        namespace,
        workspace: true,
      });
    }
  });

  test('a profile’s own keys are not, and neither is a provider’s', () => {
    // The rule is closed: anything the list does not name is the profile's.
    // Cursors are the case that matters — two agents reading one mailbox at
    // different rates must not consume each other's position.
    for (const namespace of ['cursors.v1', 'gmail/con1', 'lanes_memory/lan1', 'anything']) {
      expect({ namespace, workspace: isWorkspaceNamespace(namespace) }).toEqual({
        namespace,
        workspace: false,
      });
    }
  });

  test('an undotted spelling is not a workspace namespace', () => {
    // What the defect looked like. A provider id is `[a-z][a-z0-9_]*`, so only
    // a dotted name is one no manifest can reach — and an undotted `oauth`
    // routes to a profile, which is where the endpoint's registrations went.
    expect(isWorkspaceNamespace('oauth')).toBe(false);
    expect(isWorkspaceNamespace('oauth/clients')).toBe(false);
    expect(isWorkspaceNamespace('discovery')).toBe(false);
  });
});

describe('two stores, which is the arrangement that is shipped', () => {
  const split = () => {
    const workspace = createMemoryBlobStore();
    const profile = createMemoryBlobStore();
    return { workspace, profile, state: createRuntimeState(workspace, profile) };
  };

  test('a connection record lands in the workspace store', async () => {
    const { workspace, profile, state } = split();

    await state.connections.upsert({
      provider: 'gmail',
      id: 'con1',
      displayName: 'a@example.com',
      status: 'active',
    });

    expect((await workspace.list()).length).toBe(1);
    expect(await profile.list()).toEqual([]);
  });

  test("a cursor lands in the profile's", async () => {
    const { workspace, profile, state } = split();

    await state.cursors.set('gmail/con1', 'a-cursor');

    expect((await profile.list()).length).toBe(1);
    expect(await workspace.list()).toEqual([]);
  });

  test("the OAuth server's records land in the workspace store", async () => {
    const { workspace, profile, state } = split();
    const { OAuthStore } = await import('#auth/oauth/store.ts');

    await new OAuthStore(state.kv).registerClient({
      clientId: 'c',
      redirectUris: ['https://example.com/cb'],
      createdAt: 0,
    });

    // The assertion the defect would have failed: one endpoint, one set of
    // registrations, and removing a profile must not take them.
    expect((await workspace.list()).length).toBe(1);
    expect(await profile.list()).toEqual([]);
  });

  test("a provider's own key lands in the profile's", async () => {
    const { workspace, profile, state } = split();

    await state.kv.set('lanes_memory/lan1', 'seen', '1');

    expect((await profile.list()).length).toBe(1);
    expect(await workspace.list()).toEqual([]);
  });
});
