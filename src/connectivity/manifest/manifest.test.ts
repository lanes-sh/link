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
