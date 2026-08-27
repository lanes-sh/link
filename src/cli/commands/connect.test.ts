import { describe, expect, test } from 'bun:test';
import { idFromAccount, pluck, resolveAccount } from '../identity.ts';
import { reuseStoredCredential } from './connect/setup.ts';
import type { ProviderManifest } from '#connectivity';

/**
 * Naming a connection after the account it authorised is what removes the
 * "invent an id" step from setup — and, more importantly, what lets a re-run of
 * `connect` recognise an account it already holds instead of appending
 * `main2`, `main3` beside it.
 */

/**
 * A re-run of `connect` must always be able to correct a credential.
 *
 * It could not. A mistyped iCloud app-specific password was stored under the
 * provisional connection id, the DAV server refused it, and `connect` gave up
 * before settling the account — so every re-run found the bad password already
 * there, reported "credential already stored", and failed identically. The
 * troubleshooting line it ended on advised the command that had just looped.
 */
describe('reuseStoredCredential', () => {
  test('a stored credential under a settled id stands', () => {
    // The property the early return exists for: iCloud is three providers on
    // one app-specific password, and the second and third connect adopt the
    // first's id. Asking three times for one password is the regression here.
    expect(reuseStoredCredential({ stored: true, replace: false, provisional: false })).toBe(true);
  });

  test('a credential under the provisional id is asked for again', () => {
    // It is only there because an earlier connect stored it and then failed, so
    // nothing has ever accepted it. This is the case that needs no flag.
    expect(reuseStoredCredential({ stored: true, replace: false, provisional: true })).toBe(false);
  });

  test('--replace asks again for a credential that did settle', () => {
    // Apple revokes every app-specific password when the account password
    // changes. The connection is real, its id is real, and the credential is
    // dead — nothing about the stored state says so.
    expect(reuseStoredCredential({ stored: true, replace: true, provisional: false })).toBe(false);
  });

  test('nothing stored is always asked for, whatever the flags say', () => {
    for (const replace of [true, false]) {
      for (const provisional of [true, false]) {
        expect(reuseStoredCredential({ stored: false, replace, provisional })).toBe(false);
      }
    }
  });
});

describe('idFromAccount', () => {
  test('an email becomes its local part', () => {
    expect(idFromAccount('ada.lovelace@example.com')).toBe('ada_lovelace');
    expect(idFromAccount('r.shaw@example.com')).toBe('r_shaw');
  });

  test('a workspace name becomes a slug', () => {
    expect(idFromAccount('Lanes')).toBe('lanes');
    expect(idFromAccount('Acme Corp — EU')).toBe('acme_corp_eu');
  });

  test('the result is always a legal connection id', () => {
    for (const account of ['UPPER@X.EXAMPLE', '  spaces  ', '···', 'a@b', '💥@x.com']) {
      expect(idFromAccount(account)).toMatch(/^[a-z0-9][a-z0-9_]*$/);
    }
  });

  test('two accounts sharing a local part do not collide', () => {
    // Same name at two domains is the realistic case, and silently reusing the
    // id would point the second connection at the first one's credential.
    expect(idFromAccount('sam@work.example', ['sam'])).toBe('sam2');
    expect(idFromAccount('sam@other.example', ['sam', 'sam2'])).toBe('sam3');
  });

  test('an unusable account still yields something', () => {
    expect(idFromAccount('···')).toBe('main');
  });
});

describe('pluck', () => {
  test('reads a dotted path', () => {
    expect(pluck({ user: { emailAddress: 'a@b.example' } }, 'user.emailAddress')).toBe('a@b.example');
    expect(pluck({ emailAddress: 'a@b.example' }, 'emailAddress')).toBe('a@b.example');
  });

  test('steps through the first array element', () => {
    // MCP results arrive as a content array; the useful block is the first.
    expect(pluck({ content: [{ text: 'hello' }] }, 'content.text')).toBe('hello');
  });

  test('a missing or non-string value is null, never a guess', () => {
    expect(pluck({ user: {} }, 'user.emailAddress')).toBeNull();
    expect(pluck({ n: 42 }, 'n')).toBeNull();
    expect(pluck(null, 'a.b')).toBeNull();
    expect(pluck({ a: '' }, 'a')).toBeNull();
  });
});

describe('resolveAccount', () => {
  const base = { id: 'gmail', name: 'Gmail', version: '1', description: '' };

  const manifest = (identity: unknown): ProviderManifest =>
    ({
      ...base,
      connector: { kind: 'mcp', endpoint: 'https://x.invalid/mcp' },
      auth: { kind: 'none' },
      identity,
    }) as ProviderManifest;

  test('reads an http identity', async () => {
    const account = await resolveAccount(
      manifest({
        kind: 'http',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        field: 'emailAddress',
      }),
      {
        accessToken: async () => 'tok',
        fetch: (async (_url: string, init?: RequestInit) => {
          expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
          return new Response(JSON.stringify({ emailAddress: 'me@example.com' }));
        }) as unknown as typeof fetch,
      },
    );

    expect(account).toBe('me@example.com');
  });

  /**
   * The hole this closes.
   *
   * `accessToken` is `bearerTokenAsStored`, which throws for a stored
   * `api_key`, `header` or `basic` credential — under a comment asserting the
   * branch is unreachable. It is unreachable on an mcp connector, which is the
   * only place `defineProvider` guarantees a bearer-shaped credential, and
   * perfectly reachable on an http one. `resolveAccount`'s catch-all turned the
   * throw into `null`, so an API-key provider with an `identity:` block was
   * asked to name its account by hand on every reconnect — and a different
   * answer each time is a new connection row rather than a repair, which is how
   * `main2` and `main3` came to exist in the first place.
   */
  describe('an identity probe for a credential that is not a bearer token', () => {
    const apiKeyProvider = manifest({
      kind: 'http',
      url: 'https://api.example.com/me',
      field: 'email',
    });

    test('uses the authorizer, which knows every method', async () => {
      let sent: Request | undefined;

      const account = await resolveAccount(apiKeyProvider, {
        accessToken: async () => {
          throw new Error('a stored API key cannot be sent as a bearer token');
        },
        authorize: async (request) => {
          const authorised = new Request(request, { headers: new Headers(request.headers) });
          authorised.headers.set('x-api-key', 'k');
          return authorised;
        },
        fetch: (async (request: Request) => {
          sent = request;
          return new Response(JSON.stringify({ email: 'me@example.com' }));
        }) as unknown as typeof fetch,
      });

      expect(account).toBe('me@example.com');
      expect(sent?.headers.get('x-api-key')).toBe('k');
      expect(sent?.headers.get('authorization')).toBeNull();
    });

    test('and without one, this is the silent null it used to be', async () => {
      // Pinned rather than left implicit: the fallback is still best-effort, and
      // the fix is that a caller *can* supply the authorizer, not that the
      // absence became an error. A label is never worth failing a connect over.
      const account = await resolveAccount(apiKeyProvider, {
        accessToken: async () => {
          throw new Error('a stored API key cannot be sent as a bearer token');
        },
        fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      });

      expect(account).toBeNull();
    });

    test('an oauth provider is untouched, and still sends its token', async () => {
      // The reason `settle.ts` supplies `authorize` for three kinds and not for
      // all of them: `requestAuthorizer` may refresh, and connect-time
      // deliberately does not.
      const account = await resolveAccount(apiKeyProvider, {
        accessToken: async () => 'tok',
        fetch: (async (_url: string, init?: RequestInit) => {
          expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
          return new Response(JSON.stringify({ email: 'me@example.com' }));
        }) as unknown as typeof fetch,
      });

      expect(account).toBe('me@example.com');
    });
  });

  /**
   * Where the vendor's idea of a user is scoped to something smaller than the
   * vendor. Slack's is: `auth.test` answers with a workspace-local handle, so
   * the same person in two workspaces returns the same `user`, and one account
   * string is exactly how `settleIdentity` decides a connect is a *reconnect*.
   * Without the qualifier, connecting a second workspace matched the first and
   * overwrote its token.
   */
  const slackish = (body: Record<string, string>, identity: Record<string, string>) =>
    resolveAccount(manifest({ kind: 'http', url: 'https://slack.invalid/auth.test', ...identity }), {
      accessToken: async () => 'tok',
      fetch: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch,
    });

  test('a qualifier distinguishes one person in two workspaces', async () => {
    const identity = { field: 'user', qualifier: 'team' };

    const acme = await slackish({ user: 'alice', team: 'Acme' }, identity);
    const beta = await slackish({ user: 'alice', team: 'Beta' }, identity);

    expect(acme).toBe('alice (Acme)');
    expect(beta).toBe('alice (Beta)');
    // The property that matters: `settleIdentity` compares these strings, so
    // two workspaces must not produce one.
    expect(acme).not.toBe(beta);
  });

  test('and still tells two people in one workspace apart', async () => {
    const identity = { field: 'user', qualifier: 'team' };

    expect(await slackish({ user: 'alice', team: 'Acme' }, identity)).not.toBe(
      await slackish({ user: 'bob', team: 'Acme' }, identity),
    );
  });

  test('the qualified label slugifies whole, so the id names the workspace too', async () => {
    // No `@` in it, so `idFromAccount` keeps both halves — `alice_acme` rather
    // than two connections called `alice` and `alice2`.
    expect(idFromAccount('alice (Acme)')).toBe('alice_acme');
    expect(idFromAccount('alice (Beta)', ['alice_acme'])).toBe('alice_beta');
  });

  test('a missing qualifier degrades to the bare field rather than failing', async () => {
    // Best-effort, like everything else here: a label is worth having and never
    // worth failing a connect over.
    expect(await slackish({ user: 'alice' }, { field: 'user', qualifier: 'team' })).toBe('alice');
  });

  test('reads a tool identity through a JSON text block', async () => {
    const account = await resolveAccount(
      manifest({ kind: 'tool', tool: 'get_workspace', field: 'name', arguments: {} }),
      {
        accessToken: async () => null,
        callTool: async () => ({ content: [{ text: JSON.stringify({ name: 'Lanes' }) }] }),
      },
    );

    expect(account).toBe('Lanes');
  });

  test('a provider with no identity block resolves to null rather than guessing', async () => {
    expect(await resolveAccount(manifest(undefined), { accessToken: async () => null })).toBeNull();
  });

  test('a failing probe never throws — labelling is not worth failing a connect over', async () => {
    const account = await resolveAccount(
      manifest({ kind: 'http', url: 'https://x.invalid/p', field: 'emailAddress' }),
      {
        accessToken: async () => 'tok',
        fetch: (async () => {
          throw new Error('network down');
        }) as unknown as typeof fetch,
      },
    );

    expect(account).toBeNull();
  });

  test('a non-OK response is null, not the error body', async () => {
    const account = await resolveAccount(
      manifest({ kind: 'http', url: 'https://x.invalid/p', field: 'emailAddress' }),
      {
        accessToken: async () => 'tok',
        fetch: (async () =>
          new Response('forbidden', { status: 403 })) as unknown as typeof fetch,
      },
    );

    expect(account).toBeNull();
  });
});
