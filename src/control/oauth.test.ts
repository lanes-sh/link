import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { createRuntimeState } from '#stores/state';
import {
  PENDING_NAMESPACE,
  beginAuthorization,
  completeAuthorization,
  type AuthFlowDeps,
} from './oauth.ts';

/**
 * The browser leg of connecting, split in two because a server is not a CLI.
 *
 * `lanes link connect` holds the PKCE verifier in memory while a loopback
 * listener blocks: one process, one flow, nothing to persist. A hosted flow is
 * two separate requests that may not even reach the same instance, so what the
 * CLI keeps on the stack has to be written down.
 *
 * That is the whole difference, and it is why none of this required changing
 * `CredentialOAuthProvider`: it already takes the redirect and the browser as
 * options, and already exposes the verifier and discovery state as methods.
 */

const flow = () => {
  const blobs = createMemoryBlobStore();
  const state = createRuntimeState(blobs, createMemoryBlobStore());
  const captured: URL[] = [];

  const deps: AuthFlowDeps = {
    kv: state.kv,
    // Stands in for the SDK. `auth()` returns 'REDIRECT' having called
    // `openBrowser`, or 'AUTHORIZED' when handed a code.
    async runAuth(provider, options) {
      if (options.authorizationCode === undefined) {
        await provider.redirectToAuthorization(new URL('https://vendor.example.com/authorize?x=1'));
        provider.saveCodeVerifier('the-verifier');
        provider.saveDiscoveryState({ issuer: 'https://vendor.example.com' });
        return 'REDIRECT';
      }
      return 'AUTHORIZED';
    },
    buildProvider(input) {
      let verifier: string | undefined;
      let discovery: unknown;
      return {
        redirectToAuthorization: async (url: URL) => {
          input.openBrowser(url);
          captured.push(url);
        },
        saveCodeVerifier: (value: string) => {
          verifier = value;
        },
        codeVerifier: () => {
          if (!verifier) throw new Error('No PKCE code verifier for this flow');
          return verifier;
        },
        saveDiscoveryState: (value: unknown) => {
          discovery = value;
        },
        discoveryState: () => discovery,
      };
    },
  };

  return { deps, captured };
};

const START = {
  provider: 'notion',
  connectionId: 'con1',
  serverUrl: 'https://mcp.notion.example.com',
  redirectUrl: 'https://api.example.com/v1/auth/link/callback',
  state: 'the-state',
};

describe('beginning an authorization', () => {
  test('returns the URL the person has to open', async () => {
    const { deps } = flow();
    const begun = await beginAuthorization(START, deps);

    expect(begun.url).toBe('https://vendor.example.com/authorize?x=1');
  });

  test('never opens a browser, because there is nobody at this machine', async () => {
    // The CLI's `openBrowser` launches one. Here it captures, which is the only
    // reason this works on a server at all.
    const { deps, captured } = flow();
    await beginAuthorization(START, deps);

    expect(captured).toHaveLength(1);
  });

  test('writes down what the CLI keeps on the stack', async () => {
    const { deps } = flow();
    await beginAuthorization(START, deps);

    // Keyed by the state the vendor will hand back, which is the only thing
    // that survives the round trip.
    const held = await deps.kv.get(PENDING_NAMESPACE, 'the-state');
    expect(held).not.toBeNull();
    expect(held).toContain('the-verifier');
  });

  test('the stored flow carries no token, because none exists yet', async () => {
    const { deps } = flow();
    await beginAuthorization(START, deps);
    const held = (await deps.kv.get(PENDING_NAMESPACE, 'the-state')) ?? '';

    // A verifier is not a credential and this record must never become one:
    // the tokens the exchange produces go to the secret store, not here.
    expect(held).not.toContain('access_token');
    expect(held).not.toContain('refresh_token');
  });
});

describe('completing it', () => {
  test('restores the flow and exchanges the code', async () => {
    const { deps } = flow();
    await beginAuthorization(START, deps);

    const done = await completeAuthorization(
      { ...START, code: 'the-code' },
      deps,
    );
    expect(done).toBe(true);
  });

  test('refuses a state it never issued', async () => {
    const { deps } = flow();
    await expect(
      completeAuthorization({ ...START, state: 'invented', code: 'the-code' }, deps),
    ).rejects.toThrow(/no authorization/i);
  });

  test('consumes the record, so a replayed callback cannot exchange twice', async () => {
    const { deps } = flow();
    await beginAuthorization(START, deps);
    await completeAuthorization({ ...START, code: 'the-code' }, deps);

    expect(await deps.kv.get(PENDING_NAMESPACE, 'the-state')).toBeNull();
    await expect(
      completeAuthorization({ ...START, code: 'the-code' }, deps),
    ).rejects.toThrow(/no authorization/i);
  });

  test('two flows at once do not read each other', async () => {
    // One workspace connecting two providers, or two people connecting the
    // same one. The state is the only thing keeping them apart.
    const { deps } = flow();
    await beginAuthorization(START, deps);
    await beginAuthorization({ ...START, provider: 'linear', state: 'other-state' }, deps);

    expect(await deps.kv.get(PENDING_NAMESPACE, 'the-state')).toContain('notion');
    expect(await deps.kv.get(PENDING_NAMESPACE, 'other-state')).toContain('linear');
  });
});
