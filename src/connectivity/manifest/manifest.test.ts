import { describe, expect, test } from 'bun:test';
import { credentialRefForConnection, defineProvider } from './index.ts';

/**
 * Where a credential lives, which used to have two answers.
 *
 * Reconcile derived `<provider>/<id>` and never read the manifest; the request
 * authorizer read the manifest and never derived. A provider declaring
 * `credential_ref: mything/api_key` was therefore permanently "unauthorized",
 * and `doctor` advised running the command that had just failed to help.
 */

const http = { kind: 'http', base_url: 'https://api.test', openapi: './t.json' } as const;

const provider = (auth: Record<string, unknown>, id = 'mything') =>
  defineProvider({ id, name: id, connector: http, auth });

describe('credentialRefForConnection', () => {
  test('derives per account when nothing is declared', () => {
    const manifest = provider({ kind: 'header', header: 'X-API-Key' });

    expect(credentialRefForConnection(manifest, 'work')).toBe('mything/work');
    expect(credentialRefForConnection(manifest, 'home')).toBe('mything/home');
  });

  test('a declared ref is shared by every account', () => {
    // A service key, where the key *is* the identity — so two connections of it
    // are two views of one account, not two accounts.
    const manifest = provider({ kind: 'header', credential_ref: 'mything/api_key' });

    expect(credentialRefForConnection(manifest, 'work')).toBe('mything/api_key');
    expect(credentialRefForConnection(manifest, 'home')).toBe('mything/api_key');
  });

  test('an app groups siblings onto one per-account ref', () => {
    // Apple issues an app-specific password at account scope, so one password
    // unlocks mail, calendar, and contacts — three providers, one secret typed
    // once, still one secret *per Apple Account*.
    const mail = provider({ kind: 'basic', app: 'icloud' }, 'icloud_mail');
    const calendar = provider({ kind: 'basic', app: 'icloud' }, 'icloud_calendar');

    expect(credentialRefForConnection(mail, 'ada')).toBe('icloud/ada');
    expect(credentialRefForConnection(calendar, 'ada')).toBe('icloud/ada');

    // Shared across providers is emphatically not shared across accounts.
    expect(credentialRefForConnection(calendar, 'sam')).toBe('icloud/sam');
  });

  test('oauth tokens stay per provider even when an app is shared', () => {
    // Gmail and Drive authorise against one Google client but hold separate
    // tokens, granted under different scopes. Pointing both at one ref would
    // have the second connect silently narrow the first.
    const gmail = defineProvider({
      id: 'gmail',
      name: 'Gmail',
      connector: http,
      auth: { kind: 'oauth', registration: 'manual', app: 'google', scopes: ['a'] },
      setup: { prompts: [{ key: 'id', label: 'Client id', credential_ref: 'google/client_id' }] },
    });

    expect(credentialRefForConnection(gmail, 'main')).toBe('gmail/main');
  });

  test('a provider needing no credential has nowhere to keep one', () => {
    const local = defineProvider({ id: 'example', name: 'Example', connector: { kind: 'local' } });

    expect(credentialRefForConnection(local, 'main')).toBeUndefined();
  });
});

describe('defineProvider cross-field rules', () => {
  test('app and credential_ref together are refused as contradictory', () => {
    expect(() => provider({ kind: 'basic', app: 'icloud', credential_ref: 'icloud/shared' })).toThrow(
      /contradict/,
    );
  });

  test('a token auth needs neither, because the ref derives', () => {
    expect(() => provider({ kind: 'bearer' })).not.toThrow();
  });
});

describe('a broker as the other answer to "where does the client come from"', () => {
  const broker = { url: 'https://api.example.com/v1/auth/link/vendor', operator: 'Someone' };
  const oauth = (extra: Record<string, unknown> = {}) => ({
    kind: 'oauth',
    registration: 'manual',
    app: 'vendor',
    scopes: ['a'],
    authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.example.com/token',
    ...extra,
  });

  test('setup prompts stop being mandatory once a broker can supply the client', () => {
    // Without a broker this is the error that says a manual registration with
    // no prompts leaves nobody able to learn what to provide. With one, there
    // is simply nothing to provide.
    expect(() => provider(oauth())).toThrow(/must declare setup prompts/);
    expect(() => provider(oauth({ broker }))).not.toThrow();
  });

  test('a broker still names the oauth_apps entry that overrides it', () => {
    // Without `app` there is no way for a profile to say "use mine instead",
    // which would make the broker the only option rather than the default.
    expect(() => provider(oauth({ broker, app: undefined }))).toThrow(/registration "manual"/);
    expect(() => provider(oauth({ broker, registration: 'dynamic' }))).toThrow(/"app"/);
  });

  test('a broker needs the authorize url, because the browser still goes to the vendor', () => {
    expect(() => provider(oauth({ broker, authorize_url: undefined }))).toThrow(/authorize_url/);
  });

  test('an mcp connector is refused, because the SDK owns its exchange', () => {
    // Discovered at definition rather than after the operator has already
    // approved a consent screen.
    expect(() =>
      defineProvider({
        id: 'vendor_mcp',
        name: 'Vendor',
        connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/sse' },
        auth: oauth({ broker }),
      }),
    ).toThrow(/cannot route it through a broker/);
  });

  test('tokens still land per provider, not under the app the broker names', () => {
    const gmailish = provider(oauth({ broker }), 'vendor_mail');
    expect(credentialRefForConnection(gmailish, 'main')).toBe('vendor_mail/main');
  });
});
