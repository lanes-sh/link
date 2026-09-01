import { describe, expect, test } from 'bun:test';
import { ReauthRequired } from '#connectivity/auth/index.ts';
import { defineProvider } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import { classifyOAuth, probeConnections } from './auth.ts';
import type { Runtime } from '../../runtime.ts';

/**
 * The mapping, on its own.
 *
 * Everything expensive about `lanes link auth` is I/O, and everything that
 * could be *wrong* about it is this function. Both ways it can lie have a test
 * here, because both are the kind of bug that ships quietly: one tells someone
 * to sign in again when their network is simply down, and the other tells them
 * a dead credential is fine.
 */
describe('classifyOAuth', () => {
  test('a resolved credential is ok', () => {
    expect(classifyOAuth({ outcome: 'resolved', staleAccessToken: false })).toBe('ok');
  });

  test('a resolved credential whose stored token is still expired needs a person', () => {
    // `upstreamAccessToken` hands back the *stale* access token when there is
    // no refresh token to renew with, and again when a refresh comes back
    // without one. Both are deliberate on the serve path — a vendor 401 is the
    // truthful instruction there — but a health check that called them ok would
    // say the opposite of what the next real call finds.
    expect(classifyOAuth({ outcome: 'resolved', staleAccessToken: true })).toBe('reauth');
  });

  test('a ReauthRequired is the signal this exists for', () => {
    const error = new ReauthRequired('gmail.main', 'could not be refreshed (400)');
    expect(classifyOAuth({ outcome: 'threw', error })).toBe('reauth');
  });

  test('any other throw is unknown, never reauth', () => {
    // The wolf-crying guard. A 5xx, a DNS failure, or a bug in here must not
    // send someone through a consent screen — a warning that is wrong once is a
    // warning that gets scrolled past every time after.
    expect(classifyOAuth({ outcome: 'threw', error: new Error('fetch failed') })).toBe('unknown');
    expect(classifyOAuth({ outcome: 'threw', error: 'not even an Error' })).toBe('unknown');
  });

  test('a timeout is unknown — it is a statement about the network, not the grant', () => {
    expect(classifyOAuth({ outcome: 'timeout' })).toBe('unknown');
  });

  test('nothing to resolve is missing', () => {
    expect(classifyOAuth({ outcome: 'none' })).toBe('missing');
  });
});

/**
 * What the probe does *before* it reaches the resolver.
 *
 * The OAuth path is covered by `classifyOAuth` above and by the throw sites in
 * `refresh.test.ts`; this is the dispatch in front of both, and it exists
 * because the wrong branch here manufactures failures that are not there. The
 * `strategy` case is the specific one: `credentialResolver` refuses that kind
 * unconditionally, so a connection that signs its own requests would be
 * reported as broken by a probe that simply asked the resolver about everything.
 */
describe('probeConnections, before the resolver', () => {
  const forSelection = (command: string) => `${command} --profile p --workspace <name>`;

  const store = (seed: Record<string, string> = {}): SecretStore => {
    const map = new Map(Object.entries(seed));
    return {
      get: async (ref) => map.get(ref) ?? null,
      set: async (ref, value) => void map.set(ref, value),
      has: async (ref) => map.has(ref),
      delete: async (ref) => void map.delete(ref),
      list: async () => [...map.keys()] as SecretRef[],
    };
  };

  const provider = (id: string, auth: Record<string, unknown>) =>
    defineProvider({
      id,
      name: id,
      connector: { kind: 'http', base_url: 'https://api.test', openapi: './t.json' },
      auth: auth as never,
    });

  const runtimeWith = (manifests: ReturnType<typeof provider>[], secrets: SecretStore) =>
    ({
      credentials: secrets,
      registry: { manifest: (id: string) => manifests.find((m) => m.id === id) ?? null },
      manifestFor: (id: string) => manifests.find((m) => m.id === id),
    }) as unknown as Runtime;

  test('a strategy connection is answered from the store, never through the resolver', async () => {
    // `credentialResolver` throws for `strategy` whatever is stored, so reaching
    // it would report a working bunq connection as broken.
    const manifest = provider('bunq', { kind: 'strategy', strategy: 'bunq' });
    const runtime = runtimeWith([manifest], store({ 'bunq/joint': 'a-key' }));

    const [result] = await probeConnections(
      runtime,
      [{ provider: 'bunq', id: 'joint' } as never],
      forSelection,
    );

    expect(result!.verdict).toBe('stored');
    expect(result!.method).toBe('strategy');
    expect(result!.refreshed).toBe(false);
  });

  test('a static secret that is present is stored, not ok — nothing here exercised it', async () => {
    const manifest = provider('icloud_mail', { kind: 'basic' });
    const runtime = runtimeWith([manifest], store({ 'icloud_mail/main': 'user:pass' }));

    const [result] = await probeConnections(
      runtime,
      [{ provider: 'icloud_mail', id: 'main' } as never],
      forSelection,
    );

    expect(result!.verdict).toBe('stored');
  });

  test('a static secret that is absent is missing, and carries the command that fixes it', async () => {
    const manifest = provider('icloud_mail', { kind: 'basic' });
    const runtime = runtimeWith([manifest], store());

    const [result] = await probeConnections(
      runtime,
      [{ provider: 'icloud_mail', id: 'main' } as never],
      forSelection,
    );

    expect(result!.verdict).toBe('missing');
    expect(result!.fix).toBe('lanes link connect icloud_mail.main --profile p --workspace <name>');
  });

  test('the owner layer needs no credential and costs no store read', async () => {
    const manifest = provider('memory', { kind: 'none' });
    let reads = 0;
    const counted: SecretStore = { ...store(), has: async () => (reads++, false) };
    const runtime = runtimeWith([manifest], counted);

    const [result] = await probeConnections(
      runtime,
      [{ provider: 'memory', id: 'main' } as never],
      forSelection,
    );

    expect(result!.verdict).toBe('none');
    expect(reads).toBe(0);
  });
});
