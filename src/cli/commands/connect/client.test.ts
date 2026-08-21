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

const manifest = (broker: object | null = BROKER, withPrompts = true) =>
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
  await writeFile(join(root, 'profiles', 'personal.yaml'), body ?? newProfileTemplate('personal', 7337));
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
  ownClient: false,
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
        ownClient: true,
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
        await choice({ manifest: manifest(BROKER, false), ownClient: true }),
      ),
    ).rejects.toThrow(/no bring-your-own client path/);
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
