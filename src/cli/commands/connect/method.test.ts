import { describe, expect, test } from 'bun:test';
import { defineProvider, type ProviderManifest } from '#connectivity';
import type { Prompter } from '../../prompt.ts';
import { chooseAuthMethod, methodsFor } from './method.ts';

/**
 * Which way in, and who decides.
 *
 * Two properties matter here and neither is the wording of the prompt. A
 * provider that offers one method must never ask — adding a choice to Google
 * must not put a question in front of somebody connecting GitHub. And the
 * choice must be made from the flag or from the operator and from nothing
 * else: `chooseAuthMethod` takes no credential store, which is what makes
 * "connecting again replaces what is there" a rule rather than an accident.
 *
 * It used to take one, indirectly — a `current` argument read off the stored
 * credential, meant to default a re-run to the route the account already used.
 * It was read under the *provisional* connection id, which is `pending` until
 * identity is settled, so it was always undefined and the default was always
 * the browser. The prompt now says what the choice does instead of trying to
 * guess it.
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

/**
 * What was printed on the way to the answer.
 *
 * `progress` writes to stderr, and a warning that is built and discarded type-
 * checks and runs exactly like one that is printed — so nothing but a test
 * reading the stream can tell them apart.
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
        prompter: prompter('3'),
      }),
    ).toEqual({ kind: 'oauth', id: 'own_client', client: 'own' });

    expect(
      await chooseAuthMethod({
        manifest: manifest(true, true),
        requested: undefined,
        prompter: prompter('2'),
      }),
    ).toEqual({ kind: 'oauth', id: 'hosted_client', client: 'hosted' });
  });

  test('honours --auth without asking', async () => {
    const terminal = prompter();
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: 'service_account',
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
        prompter: prompter(),
      }),
    ).rejects.toThrow(/--auth accepts: oauth, own_client/);
  });

  test('takes the hosted client by default, which is what "as it works today" means', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true, true),
      requested: undefined,
      prompter: prompter(''),
    });

    expect(chosen).toEqual({ kind: 'oauth', id: 'hosted_client', client: 'hosted' });
  });

  test('takes the browser by default where nobody else runs a client', async () => {
    // Never the key, even though it is listed first: Enter must not mean "the
    // route with a console visit in it" for someone who was not reading.
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      prompter: prompter(''),
    });

    expect(chosen.kind).toBe('oauth');
  });

  test('accepts the method by name as well as by number', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      prompter: prompter('service_account'),
    });

    expect(chosen.kind).toBe('assertion');
  });

  test('refuses an answer that is neither', async () => {
    await expect(
      chooseAuthMethod({
        manifest: manifest(true),
        requested: undefined,
        prompter: prompter('yes'),
      }),
    ).rejects.toThrow(/not one of the choices. Answer 1 to 2/);
  });

  test('does not guess for a run with nobody to ask', async () => {
    const chosen = await chooseAuthMethod({
      manifest: manifest(true),
      requested: undefined,
      prompter: silent,
    });

    expect(chosen.kind).toBe('oauth');
  });

  test('names the route it chose, so a reconnect can report what it became', async () => {
    // `connect` puts this in `changes` — it is how somebody who passed `--auth`,
    // and was therefore never prompted, sees that the route was swapped rather
    // than the token refreshed.
    const key = await chooseAuthMethod({
      manifest: manifest(true, true),
      requested: undefined,
      prompter: prompter('1'),
    });

    expect(key).toMatchObject({ kind: 'assertion', id: 'service_account' });

    // Unset where there was no choice to report: a provider with one way in
    // reads exactly as it did before any of this existed.
    expect(
      await chooseAuthMethod({ manifest: manifest(false), requested: 'oauth', prompter: silent }),
    ).toEqual({ kind: 'oauth', client: undefined });
  });
});

describe('what the prompt says out loud', () => {
  test('warns that the choice replaces whatever the account uses now', async () => {
    // The whole of the protection that used to be attempted by defaulting. A
    // default cannot be read; a sentence can, and it is true on a first connect
    // too, where there is simply nothing to replace.
    const err = await captured(async () => {
      await chooseAuthMethod({
        manifest: manifest(true, true),
        requested: undefined,
        prompter: prompter('2'),
      });
    });

    expect(err).toContain('becomes the only way in for this account');
    expect(err).toContain('a connection authenticates one way at a time');
  });

  test('says nothing at all for a provider with one way in', async () => {
    // The property that matters more than the warning: connecting GitHub must
    // not acquire a paragraph because Google grew a second route.
    const err = await captured(async () => {
      await chooseAuthMethod({ manifest: manifest(false), requested: undefined, prompter: prompter() });
    });

    expect(err).toBe('');
  });
});
