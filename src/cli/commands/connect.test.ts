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
