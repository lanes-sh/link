import { describe, expect, test } from 'bun:test';
import { createMemoryCredentials } from '#stores/state/testing.ts';
import { scopeSecrets } from '#secrets';
import { defineProvider } from '#connectivity';
import { resolveSecretRefs } from './context.ts';
import type { ConnectionConfig } from '#profile';

/**
 * What a connection may reach, and — the point of these tests — what it may not.
 *
 * `auth.app` lets sibling providers of one vendor share a per-account secret, so
 * an iCloud app-specific password is typed once and serves mail, calendar, and
 * contacts. The risk that buys is obvious and worth pinning: shared across
 * *providers* must never quietly become shared across *accounts*.
 */

const connection = (provider: string, id: string, extra: Partial<ConnectionConfig> = {}) =>
  ({ provider, id, account: `${id}@icloud.com`, ...extra }) as ConnectionConfig;

const icloudMail = defineProvider({
  id: 'icloud_mail',
  name: 'iCloud Mail',
  connector: { kind: 'http', base_url: 'https://mail.test', openapi: './t.json' },
  auth: { kind: 'basic', app: 'icloud' },
});

describe('resolveSecretRefs', () => {
  test('a shared-app provider reaches its own account and nothing else', () => {
    const refs = resolveSecretRefs(icloudMail, connection('icloud_mail', 'ada'));

    expect(refs).toEqual(['icloud/ada']);
  });

  test('a sibling account of the same vendor is out of reach', () => {
    const refs = resolveSecretRefs(icloudMail, connection('icloud_mail', 'sam'));

    expect(refs).not.toContain('icloud/ada');
  });

  test('a hand-placed ref on the connection is added, not substituted for', () => {
    const refs = resolveSecretRefs(
      icloudMail,
      connection('icloud_mail', 'ada', { credential_ref: 'ops/shared' }),
    );

    expect(new Set(refs)).toEqual(new Set(['ops/shared', 'icloud/ada']));
  });

  test('a provider needing no credential reaches none', () => {
    const example = defineProvider({ id: 'example', name: 'Example', connector: { kind: 'local' } });

    expect(resolveSecretRefs(example, connection('example', 'main'))).toEqual([]);
  });
});

describe('the scoped store enforces it', () => {
  const store = createMemoryCredentials({
    'icloud/ada': 'ada@example.com:app-specific',
    'icloud/sam': 'sam@example.com:app-specific',
    'profile/token': 'the-endpoint-token',
  });

  const scoped = scopeSecrets(
    store,
    resolveSecretRefs(icloudMail, connection('icloud_mail', 'ada')),
  );

  test('its own account resolves', async () => {
    expect(await scoped.get('icloud/ada')).toBe('ada@example.com:app-specific');
  });

  test("another account's credential is refused, not returned empty", async () => {
    // Refusing loudly matters more than it looks: returning null would read as
    // "not connected yet" and send someone to re-run connect for an account
    // that is already fine.
    expect(scoped.get('icloud/sam')).rejects.toThrow(/not in scope/);
  });

  test('the endpoint token is not reachable from a provider at all', async () => {
    expect(scoped.get('profile/token')).rejects.toThrow(/not in scope/);
  });
});
