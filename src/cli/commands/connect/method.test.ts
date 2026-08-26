import { describe, expect, test } from 'bun:test';
import { defineProvider, type ProviderManifest } from '#connectivity';
import { ASSERTION_GRANT } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import type { Prompter } from '../../prompt.ts';
import { chooseAuthMethod, currentAuthMethod, methodsFor } from './method.ts';

/**
 * Which way in, and who decides.
 *
 * Two properties matter here and neither is about the prompt. A provider that
 * offers one method must never ask — adding a choice to Google must not put a
 * question in front of somebody connecting GitHub. And re-running `connect` on
 * an existing account must default to what that account already uses, because
 * the alternative is a repair that quietly replaces the credential it was meant
 * to repair.
 */

const ASSERTION = {
  method: 'service_account',
  label: 'Service account key',
  delegation: 'optional',
  key_ref: 'vendor/key',
  reach: 'only what is shared with it',
  subject_label: 'Account to act as',
  setup: {
    steps: [],
    prompts: [
      { key: 'key', label: 'Key', secret: true, scope: 'shared', credential_ref: 'vendor/key' },
    ],
  },
} as const;

const BROKER = { url: 'https://api.example.com/v1/auth/link/vendor', operator: 'Someone' };

function manifest(withAssertion: boolean, withBroker = false): ProviderManifest {
  return defineProvider({
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
      ...(withBroker ? { broker: BROKER } : {}),
      ...(withAssertion ? { assertion: ASSERTION } : {}),
    },
    setup: {
      prompts: [
        { key: 'client_id', label: 'Client id', credential_ref: 'vendor/client_id' },
        { key: 'client_secret', label: 'Client secret', secret: true, credential_ref: 'vendor/client_secret' },
      ],
    },
  });
}

/** A terminal that answers whatever it was handed, and records being asked. */
function prompter(answer = ''): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    askSecret: async () => answer,
    confirm: async () => true,
  };
}

const silent: Prompter = {
  interactive: false,
  ask: async () => '',
  askSecret: async () => '',
  confirm: async () => false,
};

function memoryStore(seed: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(seed));
  return {
    get: async (ref: string) => map.get(ref) ?? null,
    set: async (ref: string, value: string) => void map.set(ref, value),
    has: async (ref: string) => map.has(ref),
    delete: async (ref: string) => void map.delete(ref),
    list: async () => [...map.keys()],
  } as unknown as SecretStore;
}

describe('what a provider offers', () => {
  test('is one browser route, where a client of your own is the only way in', () => {
    expect(methodsFor(manifest(false))).toEqual(['own_client']);
  });

  test('is two browser routes, where somebody else runs a client as well', () => {
    // `--own-client` used to be the only way to reach the second of these, which
    // is to say it was a choice nobody discovered unless they already knew.
    expect(methodsFor(manifest(false, true))).toEqual(['hosted_client', 'own_client']);
  });

  test('names the key first, because it is the one worth knowing about', () => {
    expect(methodsFor(manifest(true, true))).toEqual([
      'service_account',
      'hosted_client',
      'own_client',
    ]);
  });
});

describe('choosing', () => {
  test('asks nothing at all when there is one way in', async () => {
    const terminal = prompter();
    const chosen = await chooseAuthMethod({
      manifest: manifest(false),
      requested: undefined,
      current: undefined,
      prompter: terminal,
    });

    expect(chosen).toEqual({ kind: 'oauth', client: undefined });
    expect(terminal.asked).toEqual([]);
  });

  test('leaves the client decision to the profile when it did not ask', async () => {
    // `client: undefined` is the precedence `resolveOAuthClient` has always
    // applied. A provider with one browser route must resolve to it rather than
    // to `own`, which would write an `oauth_apps` entry nobody asked for.
    const chosen = await chooseAuthMethod({
      manifest: manifest(false),
      requested: 'oauth',
      current: undefined,
      prompter: prompter(),
    });

    expect(chosen).toEqual({ kind: 'oauth', client: undefined });
  });

  test('--own-client still says what it always said', async () => {
    const terminal = prompter();
    const chosen = await chooseAuthMethod({
      manifest: manifest(true, true),
      requested: undefined,
      ownClient: true,
      current: undefined,
      prompter: terminal,
    });

    expect(chosen).toEqual({ kind: 'oauth', client: 'own' });
    expect(terminal.asked).toEqual([]);
  });

  test('offers the hosted client and a client of your own as separate answers', async () => {
    expect(
      await chooseAuthMethod({
        manifest: manifest(true, true),
        requested: undefined,
        current: undefined,
        prompter: prompter('3'),
      }),
    ).toEqual({ kind: 'oauth', client: 'own' });

    expect(
      await chooseAuthMethod({
        manifest: manifest(true, true),
        requested: undefined,
        current: undefined,
        prompter: prompter('2'),
      }),
    ).toEqual({ kind: 'oauth', client: 'hosted' });
  });

  test('honours --auth without asking', async () => {
    const terminal = prompter();
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: 'service_account',
      current: undefined,
      prompter: terminal,
    });

    expect(chosen.kind).toBe('assertion');
    expect(terminal.asked).toEqual([]);
  });

  test('refuses a method the provider does not have, listing the ones it does', async () => {
    await expect(
      chooseAuthMethod({
        manifest: manifest(true),
        requested: 'app_password',
        current: undefined,
        prompter: prompter(),
      }),
    ).rejects.toThrow(
      /cannot authenticate with "app_password"[\s\S]*oauth, service_account, own_client/,
    );
  });

  test('refuses the alternative on a provider that does not offer it', async () => {
    await expect(
      chooseAuthMethod({
        manifest: manifest(false),
        requested: 'service_account',
        current: undefined,
        prompter: prompter(),
      }),
    ).rejects.toThrow(/--auth accepts: oauth, own_client/);
  });

  test('takes the hosted client by default, which is what "as it works today" means', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true, true),
      requested: undefined,
      current: undefined,
      prompter: prompter(''),
    });

    expect(chosen).toEqual({ kind: 'oauth', client: 'hosted' });
  });

  test('takes the browser by default where nobody else runs a client', async () => {
    // Never the key, even though it is listed first: Enter must not mean "the
    // route with a console visit in it" for someone who was not reading.
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      current: undefined,
      prompter: prompter(''),
    });

    expect(chosen.kind).toBe('oauth');
  });

  test('defaults to what the connection already uses, so a re-run repairs rather than replaces', async () => {
    // The footgun this exists to close: `connect vendor_mail.main` on a key-backed
    // connection, Enter pressed out of habit, and the key silently swapped for a
    // browser flow the operator did not ask for.
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      current: 'assertion',
      prompter: prompter(''),
    });

    expect(chosen.kind).toBe('assertion');
  });

  test('accepts the method by name as well as by number', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      current: undefined,
      prompter: prompter('service_account'),
    });

    expect(chosen.kind).toBe('assertion');
  });

  test('refuses an answer that is neither', async () => {
    await expect(
      chooseAuthMethod({
        manifest: manifest(true),
        requested: undefined,
        current: undefined,
        prompter: prompter('yes'),
      }),
    ).rejects.toThrow(/not one of the choices. Answer 1 to 2/);
  });

  test('does not guess for a run with nobody to ask', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      current: undefined,
      prompter: silent,
    });

    expect(chosen.kind).toBe('oauth');
  });

  test('keeps a key-backed connection on its key when nobody is there to ask', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      current: 'assertion',
      prompter: silent,
    });

    expect(chosen.kind).toBe('assertion');
  });
});

describe('what a connection uses today', () => {
  test('is nothing, for one that does not exist yet', async () => {
    expect(await currentAuthMethod(manifest(true), 'main', memoryStore())).toBeUndefined();
  });

  test('is read off the credential, not off config', async () => {
    const store = memoryStore({
      'vendor_mail/main': JSON.stringify({ grant: ASSERTION_GRANT, key_ref: 'vendor/key' }),
    });

    expect(await currentAuthMethod(manifest(true), 'main', store)).toBe('assertion');
  });

  test('is the browser for a stored token blob', async () => {
    const store = memoryStore({
      'vendor_mail/main': JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    });

    expect(await currentAuthMethod(manifest(true), 'main', store)).toBe('own');
  });
});
