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

describe('what an mcp connector may authenticate with', () => {
  /**
   * The transport sends one header and only one. Every rule here exists
   * because the alternative is a manifest that validates, connects, and comes
   * back with an empty tool list — no error anywhere to say the credential
   * never left the machine.
   */
  const mcp = (auth: Record<string, unknown>, connector: Record<string, unknown> = {}) =>
    defineProvider({
      id: 'vendor_mcp',
      name: 'Vendor',
      connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp', ...connector },
      auth,
    });

  test('the three kinds it can actually send are accepted', () => {
    expect(() => mcp({ kind: 'none' })).not.toThrow();
    expect(() => mcp({ kind: 'oauth', registration: 'dynamic' })).not.toThrow();
    expect(() => mcp({ kind: 'bearer' })).not.toThrow();
  });

  test('a credential the transport has nowhere to put is refused', () => {
    // Not a style preference: `api_key` wants a query string or a header of
    // its own, `basic` a different scheme entirely. The transport reads only
    // the token, so each of these would be dropped in silence.
    expect(() => mcp({ kind: 'api_key' })).toThrow(/must be "none", "oauth", or "bearer"/);
    expect(() => mcp({ kind: 'header', header: 'X-Token' })).toThrow(/nowhere else on the request/);
    expect(() => mcp({ kind: 'basic' })).toThrow(/must be "none", "oauth", or "bearer"/);
    // `strategy` is refused too, but earlier and for every connector — see
    // below. Asserting it here would read as an mcp rule, which it is not.
  });

  test('bearer may not rename its header here, though the schema allows it', () => {
    // `resolveBearer` honours a chosen header and the mcp transport never
    // reads it, so this is the same silent drop one field further in.
    expect(() => mcp({ kind: 'bearer', header: 'x-auth' })).toThrow(/cannot be honoured/);
    expect(() => mcp({ kind: 'bearer' })).not.toThrow();
  });

  test('connector headers may not claim Authorization, in any casing', () => {
    // Configuration the *server* offers, not a second place to put the
    // credential. Both set, which one wins is merge order.
    expect(() => mcp({ kind: 'bearer' }, { headers: { 'X-MCP-Toolsets': 'issues' } })).not.toThrow();
    expect(() => mcp({ kind: 'bearer' }, { headers: { Authorization: 'Bearer x' } })).toThrow(
      /may not set "Authorization"/,
    );
    expect(() => mcp({ kind: 'bearer' }, { headers: { authorization: 'Bearer x' } })).toThrow(
      /the credential comes from auth/,
    );
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

  const mcp = (auth: Record<string, unknown>) =>
    defineProvider({
      id: 'vendor_mcp',
      name: 'Vendor',
      connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp' },
      auth,
    });

  test('an mcp connector may be brokered once it names its own endpoints', () => {
    // This used to be refused outright, on the grounds that the SDK owns an MCP
    // provider's exchange and there is no seam to route it. The seam is naming
    // the endpoints: that takes the provider off the SDK's flow and onto the
    // one this repository drives, where the exchange is ours. See ADR-040.
    expect(() => mcp(oauth({ broker }))).not.toThrow();
  });

  test('an mcp connector without a token url is refused, because the SDK would own it', () => {
    // Half-declared is the dangerous state: the SDK would run the flow and then
    // post to the token endpoint with a client the broker holds and it does
    // not. Refused at definition rather than after a consent screen.
    expect(() => mcp(oauth({ broker, token_url: undefined }))).toThrow(/auth\.token_url/);
  });

  test('tokens still land per provider, not under the app the broker names', () => {
    const gmailish = provider(oauth({ broker }), 'vendor_mail');
    expect(credentialRefForConnection(gmailish, 'main')).toBe('vendor_mail/main');
  });
});

/**
 * A second way in, declared on the block that already describes the first.
 *
 * `auth.assertion` is not a `kind`, which is the whole reason it needs its own
 * guards: nothing about the discriminated union stops a manifest declaring one
 * somewhere it cannot possibly work, so `defineProvider` has to. Each of these
 * would otherwise be discovered by an operator, after choosing the method, with
 * a credential already stored.
 */
describe('an assertion alternative', () => {
  const assertion = {
    method: 'service_account',
    label: 'Service account key',
    key_ref: 'vendor/key',
    reach: 'only what is shared with it',
    subject_label: 'Account to act as',
    setup: {
      prompts: [
        { key: 'key', label: 'Key', secret: true, scope: 'shared', credential_ref: 'vendor/key' },
      ],
    },
  };

  const withAssertion = (overrides: Record<string, unknown> = {}) => ({
    kind: 'oauth',
    registration: 'manual',
    app: 'vendor',
    scopes: ['https://api.test/auth/read'],
    authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.example.com/token',
    setup: { prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }] },
    assertion: { ...assertion, ...overrides },
  });

  test('is accepted beside the browser flow, and changes where nothing lands', () => {
    const manifest = defineProvider({
      id: 'vendor_mail',
      name: 'Vendor Mail',
      connector: http,
      auth: withAssertion(),
      setup: { prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }] },
    });

    // Still per provider, and still where the OAuth path already looks: both
    // methods write here, and only the shape of what is stored tells them apart.
    expect(credentialRefForConnection(manifest, 'main')).toBe('vendor_mail/main');
  });

  test('defaults to standing on its own, rather than borrowing an identity', () => {
    const manifest = defineProvider({
      id: 'vendor_mail',
      name: 'Vendor Mail',
      connector: http,
      auth: withAssertion(),
      setup: { prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }] },
    });

    expect(manifest.auth.kind === 'oauth' && manifest.auth.assertion?.delegation).toBe('optional');
  });

  test('is refused on an mcp connector, where there is nowhere to present it', () => {
    expect(() =>
      defineProvider({
        id: 'vendor_mcp',
        name: 'Vendor',
        connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/sse' },
        auth: withAssertion(),
        setup: { prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }] },
      }),
    ).toThrow(/cannot present a signed assertion/);
  });

  test('is refused with no scopes, because the token would be permitted nothing', () => {
    expect(() =>
      defineProvider({
        id: 'vendor_mail',
        name: 'Vendor Mail',
        connector: http,
        auth: { ...withAssertion(), scopes: [], broker: undefined },
        setup: { prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }] },
      }),
    ).toThrow(/nothing to grant/);
  });

  test('is refused with no prompt, because there is no key to ask for', () => {
    expect(() =>
      defineProvider({
        id: 'vendor_mail',
        name: 'Vendor Mail',
        connector: http,
        auth: withAssertion({ setup: { prompts: [] } }),
        setup: { prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }] },
      }),
    ).toThrow(/no way to learn what key to ask for/);
  });
});

describe('the two answers to "where does the browser come back to"', () => {
  const httpProvider = (auth: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    defineProvider({
      id: 'vendor_api',
      name: 'Vendor',
      connector: { kind: 'http', base_url: 'https://api.example.com', openapi: 'specs/vendor.json' },
      auth,
      ...extra,
    });

  const oauth = (extra: Record<string, unknown>) => ({
    kind: 'oauth',
    registration: 'manual',
    app: 'vendor',
    authorize_url: 'https://accounts.example.com/authorize',
    token_url: 'https://accounts.example.com/token',
    ...extra,
  });

  test('a fixed loopback redirect is accepted on its own', () => {
    expect(() =>
      httpProvider(
        oauth({ redirect_uri: 'http://127.0.0.1:8765/callback' }),
        {
          setup: {
            summary: 'Register a client.',
            prompts: [{ key: 'client_id', label: 'Client id', scope: 'shared', credential_ref: 'vendor/client_id' }],
          },
        },
      ),
    ).not.toThrow();
  });

  test('declaring a broker as well is refused', () => {
    // Both are answers to the same question and the flow reads one of them. A
    // brokered redirect is the broker's own origin, with the loopback port
    // carried in `state`; a fixed redirect is this machine, named exactly.
    expect(() =>
      httpProvider(
        oauth({
          redirect_uri: 'http://127.0.0.1:8765/callback',
          broker: { url: 'https://broker.example.com/v1/auth', operator: 'Someone' },
        }),
      ),
    ).toThrow(/"broker" or "redirect_uri", not both/);
  });
});

describe('connector headers may not carry the credential', () => {
  // The rule was written when `mcp` was the only connector with headers, but
  // the reasoning never had anything to do with which transport carried them:
  // a manifest setting both leaves which one is sent up to merge order.
  test('an http connector naming Authorization is refused', () => {
    expect(() =>
      defineProvider({
        id: 'vendor_api',
        name: 'Vendor',
        connector: {
          kind: 'http',
          base_url: 'https://api.example.com',
          openapi: 'specs/vendor.json',
          headers: { Authorization: 'Bearer nope' },
        },
        auth: { kind: 'bearer' },
      }),
    ).toThrow(/may not set "Authorization"/);
  });

  test('any other header is fine', () => {
    expect(() =>
      defineProvider({
        id: 'vendor_api',
        name: 'Vendor',
        connector: {
          kind: 'http',
          base_url: 'https://api.example.com',
          openapi: 'specs/vendor.json',
          headers: { 'User-Agent': 'vendor:1.0 (by someone)' },
        },
        auth: { kind: 'bearer' },
      }),
    ).not.toThrow();
  });
});

describe('an auth strategy nothing implements', () => {
  const withAuth = (auth: Record<string, unknown>) =>
    defineProvider({
      id: 'thing',
      name: 'Thing',
      connector: { kind: 'http', base_url: 'https://api.example.com', openapi: './thing.json' },
      auth,
    });

  /**
   * The gap this closes.
   *
   * `refuseStrategy` throws, and loudly — but it throws when a capability is
   * *invoked*. So a manifest declaring a strategy validated here, connected,
   * stored a credential, discovered its capabilities and was granted a policy
   * rule, and then failed on every call with nothing earlier to read. Every
   * other "validates and then cannot work" pairing is caught in this function;
   * this one was not.
   */
  test('is refused where every other unusable pairing is refused', () => {
    expect(() => withAuth({ kind: 'strategy', strategy: 'bunq' })).toThrow(
      /strategy "bunq" is not registered/,
    );
  });

  test('the refusal says what would have happened, not just that it is refused', () => {
    expect(() => withAuth({ kind: 'strategy', strategy: 'bunq' })).toThrow(
      /fail on every call/,
    );
  });

  test('and it is refused whatever it is bolted to', () => {
    // Not a property of one transport: there is no code to run, whichever
    // connector would have called it.
    for (const connector of [
      { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp' },
      { kind: 'http', base_url: 'https://api.example.com', openapi: './x.json' },
    ]) {
      expect(() =>
        defineProvider({
          id: 'thing',
          name: 'Thing',
          connector,
          auth: { kind: 'strategy', strategy: 'bunq' },
        }),
      ).toThrow(/strategy/);
    }
  });
});
