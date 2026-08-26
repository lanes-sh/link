import { localBlock } from '../profile/declare.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProvider } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import { ConfigDocument, newProfileTemplate } from '../../config-edit.ts';
import { nonInteractivePrompter } from '../../prompt.ts';
import { brokeredScopes, hostedClientRefusal, resolveOAuthClient } from './client.ts';

/**
 * Which client a connection authorises against, and who decides.
 *
 * The manifest cannot: a provider that declares a broker is still one an
 * operator may want to register their own client for, so the decision belongs
 * to the profile. Declaring an `oauth_apps` entry is how a profile says "mine";
 * leaving it out is how it says "yours". These pin that, and pin the one thing
 * that must never happen — a profile silently moving off a client it registered,
 * which would refuse every refresh token it already holds.
 */

const BROKER = { url: 'https://api.example.com/v1/auth/link/vendor', operator: 'Someone' };

const SHIPPED_ID = 'shipped-client';

const manifest = (broker: object | null = BROKER, withPrompts = true, shipped?: string) =>
  defineProvider({
    id: 'vendor_mail',
    name: 'Vendor Mail',
    connector: { kind: 'http', base_url: 'https://api.test', openapi: './t.json' },
    auth: {
      kind: 'oauth',
      registration: 'manual',
      app: 'vendor',
      scopes: ['https://api.test/auth/mail.read'],
      authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.example.com/token',
      ...(broker ? { broker } : {}),
      ...(shipped ? { client_id: shipped } : {}),
    },
    ...(withPrompts
      ? {
          setup: {
            prompts: [
              { key: 'client_id', label: 'Client id', credential_ref: 'vendor/client_id' },
              {
                key: 'client_secret',
                label: 'Client secret',
                secret: true,
                credential_ref: 'vendor/client_secret',
              },
            ],
          },
        }
      : {}),
  });

function memoryStore(seed: Record<string, string> = {}): SecretStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get: async (ref) => map.get(ref) ?? null,
    set: async (ref, value) => void map.set(ref, value),
    has: async (ref) => map.has(ref),
    delete: async (ref) => void map.delete(ref),
    list: async (prefix) =>
      [...map.keys()].filter((k) => !prefix || k.startsWith(prefix)) as SecretRef[],
  };
}

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function document(body?: string): Promise<ConfigDocument> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-client-'));
  roots.push(root);
  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'profiles', 'personal.yaml'), body ?? newProfileTemplate('personal', 7337, localBlock('personal')));
  return await ConfigDocument.open(root, 'personal');
}

function brokerAnswering(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

const OPEN = {
  success: true,
  data: {
    client_id: 'hosted-client',
    scopes_supported: ['https://api.test/auth/mail.read'],
    identity_scopes: ['openid', 'email'],
    status: 'open',
  },
};

const choice = async (over: Partial<Parameters<typeof resolveOAuthClient>[0]> = {}) => ({
  manifest: manifest(),
  credentials: memoryStore(),
  document: await document(),
  changes: [] as string[],
  firstForProvider: true,
  client: undefined,
  target: 'vendor_mail',
  profile: 'personal',
  fetch: brokerAnswering(OPEN),
  ...over,
});

describe('which client a connect uses', () => {
  test('no broker declared is the path that was always here', async () => {
    const client = await resolveOAuthClient(
      await choice({
        manifest: manifest(null),
        credentials: memoryStore({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' }),
      }),
    );

    expect(client.kind).toBe('own');
  });

  test('a broker and an unconfigured profile is brokered', async () => {
    const client = await resolveOAuthClient(await choice());

    expect(client.kind).toBe('brokered');
    if (client.kind === 'brokered') expect(client.config.clientId).toBe('hosted-client');
  });

  test('a profile that declares oauth_apps is never moved off its own client', async () => {
    // The tokens it already holds were minted by that client; another one would
    // refuse every refresh. So the declaration wins over the default, silently
    // and always.
    const doc = await document();
    doc.setIn(['oauth_apps', 'vendor'], {
      client_id_ref: 'vendor/client_id',
      client_secret_ref: 'vendor/client_secret',
    });

    const client = await resolveOAuthClient(
      await choice({
        document: doc,
        credentials: memoryStore({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' }),
      }),
    );

    expect(client.kind).toBe('own');
  });

  test('a client sitting in the store counts, even with the config block gone', async () => {
    // Someone who placed the two values by hand keeps their client rather than
    // being quietly moved onto a different one.
    const client = await resolveOAuthClient(
      await choice({
        credentials: memoryStore({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' }),
      }),
    );

    expect(client.kind).toBe('own');
  });

  test('--own-client opts out, and writes the entry that makes it stick', async () => {
    const doc = await document();
    const changes: string[] = [];

    const client = await resolveOAuthClient(
      await choice({
        document: doc,
        changes,
        client: 'own' as const,
        credentials: memoryStore({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' }),
      }),
    );

    expect(client.kind).toBe('own');
    expect(doc.getIn(['oauth_apps', 'vendor'])).toBeDefined();
    expect(changes).toContain('oauth_apps.vendor declared');
  });

  test('--own-client on a provider that describes no client refuses, and says why', async () => {
    await expect(
      resolveOAuthClient(
        await choice({ manifest: manifest(BROKER, false), client: 'own' }),
      ),
    ).rejects.toThrow(/no bring-your-own client path/);
  });
});

/**
 * Asking outright, on a profile that already registered a client.
 *
 * The `oauth_apps` entry used to be final, and it was final for a good reason:
 * a refresh token minted by one client is refused by another, so a profile
 * silently moved off its own client would find every existing connection
 * unrefreshable. What makes overriding it safe is that the *token* records
 * which client minted it — so an override moves this connection and no other.
 */
describe('overriding the profile', () => {
  const registered = () =>
    memoryStore({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' });

  test('the hosted client is used when it is the answer given', async () => {
    const client = await resolveOAuthClient(
      await choice({ credentials: registered(), client: 'hosted' }),
    );

    expect(client.kind).toBe('brokered');
  });

  test('the profile keeps its own client when nothing was asked for', async () => {
    // The precedence that has always applied, unchanged by the override above:
    // an unanswered connect on a profile that registered a client stays on it.
    const client = await resolveOAuthClient(await choice({ credentials: registered() }));

    expect(client.kind).toBe('own');
  });

  test('overriding does not un-declare the entry the profile holds', async () => {
    const changes: string[] = [];
    const doc = await document();

    await resolveOAuthClient(
      await choice({ credentials: registered(), client: 'hosted', document: doc, changes }),
    );

    // The other connections still refresh against it. Removing the entry here
    // would be an edit on their behalf that nobody asked for.
    expect(changes).toEqual([]);
  });
});

describe('refusing before the browser opens', () => {
  test('a closed broker refuses with its own words and the way out', async () => {
    const error = (await resolveOAuthClient(
      await choice({
        fetch: brokerAnswering({
          success: true,
          data: { client_id: 'c', status: 'closed', notice: 'At capacity.' },
        }),
      }),
    ).catch((e) => e)) as Error;

    expect(error.message).toContain('At capacity.');
    expect(error.message).toContain('Nothing was written');
    expect(error.message).toContain(
      'lanes link connect vendor_mail --profile personal --own-client',
    );
  });

  test('a scope the hosted client cannot grant is caught here, not at the consent screen', async () => {
    const error = (await resolveOAuthClient(
      await choice({
        fetch: brokerAnswering({
          success: true,
          data: { client_id: 'c', scopes_supported: ['something.else'], status: 'open' },
        }),
      }),
    ).catch((e) => e)) as Error;

    expect(error.message).toContain('mail.read');
  });

  test('an unreachable broker is a refusal, not a stack trace', async () => {
    const fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const error = (await resolveOAuthClient(await choice({ fetch })).catch((e) => e)) as Error;

    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).toContain('--own-client');
  });

  test('a broker that does not advertise its scopes is trusted rather than refused', async () => {
    // Silence is not the same as "supports nothing". Treating it as refusal
    // would break every connection against a broker that simply does not say.
    const client = await resolveOAuthClient(
      await choice({
        fetch: brokerAnswering({ success: true, data: { client_id: 'c', status: 'open' } }),
      }),
    );

    expect(client.kind).toBe('brokered');
  });

  test('a non-interactive run still reaches the broker rather than prompting', async () => {
    const client = await resolveOAuthClient(
      await choice({ prompter: nonInteractivePrompter('lanes link setup plan vendor_mail') }),
    );

    expect(client.kind).toBe('brokered');
  });
});

describe('brokeredScopes', () => {
  const config = {
    clientId: 'c',
    scopesSupported: ['a', 'b'],
    identityScopes: ['openid', 'email'],
    open: true,
    notice: undefined,
    docsUrl: undefined,
    capacity: undefined,
    redirectUri: undefined,
  };

  test('appends the identity scopes the broker asks for', () => {
    expect(brokeredScopes(['a'], config).scopes).toEqual(['a', 'openid', 'email']);
  });

  test('does not duplicate one the provider already wanted', () => {
    expect(brokeredScopes(['a', 'openid'], config).scopes).toEqual(['a', 'openid', 'email']);
  });

  test('names what the broker cannot grant rather than silently dropping it', () => {
    expect(brokeredScopes(['a', 'zzz'], config).unsupported).toEqual(['zzz']);
  });
});

describe('hostedClientRefusal', () => {
  test('says nothing was kept once consent has already been given', () => {
    const message = hostedClientRefusal({
      manifest: manifest(),
      target: 'vendor_mail.ada',
      profile: 'work',
      operator: 'Someone',
      cause: 'the exchange was refused',
      afterConsent: true,
    }).message;

    expect(message).toContain('You approved the consent screen');
    expect(message).toContain('--profile work');
    // The real target, not the provider id, so the line can be pasted as-is.
    expect(message).toContain('vendor_mail.ada');
  });

  test('does not offer a console visit for something a console visit will not fix', () => {
    const message = hostedClientRefusal({
      manifest: manifest(),
      target: 'vendor_mail',
      profile: 'personal',
      operator: 'Someone',
      cause: 'invalid_grant',
      ownClient: false,
    }).message;

    expect(message).not.toContain('--own-client');
  });
});

/**
 * Notes on the way to a connection go to stderr, and they have to actually
 * arrive there.
 *
 * `warn` formats a line; `progress` is what writes it. Calling `warn` bare
 * type-checks, runs, builds the sentence and discards it — which is what had
 * happened to the near-capacity notice below. Nothing but a test that reads the
 * stream catches that, because every other signal says the code ran.
 */
async function captured(body: () => Promise<void>): Promise<string> {
  const errWrite = process.stderr.write.bind(process.stderr);
  let err = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string) => ((err += chunk), true);
  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = errWrite;
  }
  return err;
}

describe('what a brokered connect says out loud', () => {
  test('says the shared client is filling up, on the stream', async () => {
    const nearlyFull = {
      success: true,
      data: { ...OPEN.data, capacity: { accounts: 93, cap: 100 } },
    };

    const err = await captured(async () => {
      await resolveOAuthClient(await choice({ fetch: brokerAnswering(nearlyFull) }));
    });

    expect(err).toContain('near capacity');
    expect(err).toContain('93 of 100');
  });

  test('stays quiet while there is room, so the notice keeps its weight', async () => {
    const roomy = {
      success: true,
      data: { ...OPEN.data, capacity: { accounts: 12, cap: 100 } },
    };

    const err = await captured(async () => {
      await resolveOAuthClient(await choice({ fetch: brokerAnswering(roomy) }));
    });

    expect(err).not.toContain('near capacity');
  });

  test('says so when the broker origin has been moved', async () => {
    // The case worth catching is not the deliberate one — it is the variable
    // still exported in a shell three days later, deciding where a real
    // authorization code goes.
    const before = process.env['LANES_LINK_BROKER_ORIGIN'];
    process.env['LANES_LINK_BROKER_ORIGIN'] = 'http://127.0.0.1:8080';
    try {
      const err = await captured(async () => {
        await resolveOAuthClient(await choice());
      });

      expect(err).toContain('LANES_LINK_BROKER_ORIGIN is set');
      expect(err).toContain('http://127.0.0.1:8080');
      expect(err).toContain('not by Someone');
    } finally {
      if (before === undefined) delete process.env['LANES_LINK_BROKER_ORIGIN'];
      else process.env['LANES_LINK_BROKER_ORIGIN'] = before;
    }
  });

  test('says nothing about an origin nobody moved', async () => {
    const err = await captured(async () => {
      await resolveOAuthClient(await choice());
    });

    expect(err).not.toContain('LANES_LINK_BROKER_ORIGIN');
  });
});

/**
 * A broker that cannot serve, for a provider that has no other way in.
 *
 * There was briefly a fallback here — a client id shipped in the manifest,
 * redeemed locally with PKCE. The relay removed it: Slack will not register a
 * loopback redirect, so the browser has to land on the broker's own HTTPS
 * origin, and a client with no broker behind it has nowhere for the redirect to
 * go. A refusal is the honest answer and these hold it.
 */
describe('a broker that cannot serve', () => {
  const unreachable = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof globalThis.fetch;

  test('is a refusal, not a silent downgrade', async () => {
    await expect(resolveOAuthClient(await choice({ fetch: unreachable }))).rejects.toThrow(
      /could not be authorised/,
    );
  });

  test('and so is one that has closed its doors', async () => {
    const closed = brokerAnswering({
      success: true,
      data: { client_id: 'hosted-client', status: 'closed', notice: 'Paused.' },
    });

    await expect(resolveOAuthClient(await choice({ fetch: closed }))).rejects.toThrow(/Paused\./);
  });

  test('a profile with its own client does not need it and is unaffected', async () => {
    const client = await resolveOAuthClient(
      await choice({
        credentials: memoryStore({ 'vendor/client_id': 'mine', 'vendor/client_secret': 's' }),
        fetch: unreachable,
      }),
    );

    expect(client.kind).toBe('own');
    if (client.kind === 'own') expect(client.clientId).toBe('mine');
  });

  test('the relay it publishes reaches the caller', async () => {
    // The CLI never hardcodes this: which URL is right depends on which
    // deployment answered, so the broker that owns it says what it is.
    const withRelay = brokerAnswering({
      success: true,
      data: {
        client_id: 'hosted-client',
        scopes_supported: ['https://api.test/auth/mail.read'],
        status: 'open',
        redirect_uri: 'https://api.example.com/v1/auth/link/vendor/callback',
      },
    });

    const client = await resolveOAuthClient(await choice({ fetch: withRelay }));

    expect(client.kind).toBe('brokered');
    if (client.kind === 'brokered') {
      expect(client.config.redirectUri).toBe('https://api.example.com/v1/auth/link/vendor/callback');
    }
  });

  test('a broker that publishes none leaves the listener to name itself', async () => {
    const client = await resolveOAuthClient(await choice());
    expect(client.kind).toBe('brokered');
    if (client.kind === 'brokered') expect(client.config.redirectUri).toBeUndefined();
  });
});
