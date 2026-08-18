import { describe, expect, test } from 'bun:test';
import {
  assertValidSecretRef,
  isValidSecretRef,
  scopeSecrets,
  type SecretStore,
} from './index.ts';

function memoryStore(entries: Record<string, string>): SecretStore {
  const map = new Map(Object.entries(entries));
  return {
    async get(ref) {
      return map.get(ref) ?? null;
    },
    async set(ref, value) {
      map.set(ref, value);
    },
    async has(ref) {
      return map.has(ref);
    },
    async delete(ref) {
      map.delete(ref);
    },
    async list(prefix) {
      return [...map.keys()].filter((key) => !prefix || key.startsWith(prefix));
    },
  };
}

describe('credential reference validation', () => {
  test('accepts namespaced lowercase refs', () => {
    expect(isValidSecretRef('gmail/main')).toBe(true);
    expect(isValidSecretRef('google/client_secret')).toBe(true);
    expect(isValidSecretRef('profile/token')).toBe(true);
  });

  test('rejects refs that could traverse or collide', () => {
    expect(isValidSecretRef('gmail')).toBe(false); // must be namespaced
    expect(isValidSecretRef('../gmail/main')).toBe(false);
    expect(isValidSecretRef('gmail//main')).toBe(false);
    expect(isValidSecretRef('Gmail/Main')).toBe(false); // case would let two refs collide
    expect(isValidSecretRef('gmail/main ')).toBe(false);
    expect(isValidSecretRef('')).toBe(false);
  });

  test('the assertion names the offending value', () => {
    expect(() => assertValidSecretRef('nope')).toThrow(/nope/);
  });
});

describe('scoped credentials', () => {
  const store = memoryStore({
    'gmail/main': 'refresh-token-main',
    'gmail/side': 'refresh-token-side',
    'google/client_secret': 'app-secret',
    'profile/token': 'llk_profile',
  });

  test('reads a reference that is in scope', async () => {
    const scoped = scopeSecrets(store, ['gmail/main']);
    expect(await scoped.get('gmail/main')).toBe('refresh-token-main');
    expect(await scoped.has('gmail/main')).toBe(true);
  });

  test('one connection cannot read another connection of the same provider', async () => {
    const scoped = scopeSecrets(store, ['gmail/main']);
    await expect(scoped.get('gmail/side')).rejects.toThrow(/not in scope/);
    await expect(scoped.has('gmail/side')).rejects.toThrow(/not in scope/);
  });

  test('a provider cannot reach the profile token or an undeclared app secret', async () => {
    // This is the load-bearing one. A provider that could read `profile/token`
    // holds the endpoint's identity; one that could read an arbitrary app
    // secret escapes its connection entirely.
    const scoped = scopeSecrets(store, ['gmail/main']);
    await expect(scoped.get('profile/token')).rejects.toThrow(/not in scope/);
    await expect(scoped.get('google/client_secret')).rejects.toThrow(/not in scope/);
  });

  test('an out-of-scope ref is indistinguishable from a missing one', async () => {
    const scoped = scopeSecrets(store, ['gmail/main']);
    let existing = '';
    let missing = '';
    await scoped.get('gmail/side').catch((error: Error) => (existing = error.message));
    await scoped.get('gmail/nothing_here').catch((error: Error) => (missing = error.message));

    // Both must fail the same way, or the error itself enumerates the store.
    expect(existing.replace('gmail/side', 'X')).toBe(missing.replace('gmail/nothing_here', 'X'));
  });

  test('the scoped surface offers no way to write or enumerate', () => {
    const scoped = scopeSecrets(store, ['gmail/main']);
    const surface = scoped as unknown as Record<string, unknown>;

    expect(Object.keys(scoped).sort()).toEqual(['get', 'has']);
    expect(surface['set']).toBeUndefined();
    expect(surface['list']).toBeUndefined();
    expect(surface['delete']).toBeUndefined();
  });

  test('an empty allowlist reaches nothing', async () => {
    const scoped = scopeSecrets(store, []);
    await expect(scoped.get('gmail/main')).rejects.toThrow(/not in scope/);
  });
});
