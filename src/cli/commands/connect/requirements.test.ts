import { describe, expect, test } from 'bun:test';
import { assertValidSecretRef } from '#secrets';
import { defineProvider } from '#connectivity';
import { setupRequirements } from '#connectivity';
import { missingRequirements, preflight } from './requirements.ts';

/**
 * What a provider needs before `connect` can finish.
 *
 * Three callers have to agree on this answer — the non-interactive preflight,
 * `lanes link setup plan`, and the read-only `setup.provider` capability — so
 * the property worth holding is that the command it emits is one somebody can
 * actually paste. A `secrets set` line naming a ref the credential store would
 * reject, or storing half of a `basic` credential, is a wrong answer that looks
 * like a right one.
 */

const HEADER = defineProvider({
  id: 'thing',
  name: 'Thing',
  version: '1.0.0',
  description: 'a provider with one per-account key',
  connector: { kind: 'http', base_url: 'https://example.test', openapi: './x.json' },
  auth: { kind: 'header', header: 'X-Key' },
  setup: {
    steps: ['Make a key'],
    prompts: [{ key: 'key', label: 'API key', secret: true, scope: 'connection', field: 'value' }],
  },
});

const BASIC = defineProvider({
  id: 'post',
  name: 'Post',
  version: '1.0.0',
  description: 'a provider authenticating with a username and a password',
  connector: { kind: 'imap', host: 'imap.example.test', port: 993, tls: true },
  auth: { kind: 'basic', app: 'post' },
  setup: {
    steps: ['Make an app password'],
    prompts: [
      { key: 'username', label: 'Account', secret: false, scope: 'connection', field: 'username' },
      { key: 'password', label: 'App password', secret: true, scope: 'connection', field: 'password' },
    ],
  },
});

const NO_AUTH = defineProvider({
  id: 'plain',
  name: 'Plain',
  version: '1.0.0',
  description: 'a provider that authenticates to nothing',
  connector: { kind: 'local' },
  auth: { kind: 'none' },
});

describe('setupRequirements', () => {
  test('a per-account key derives one ref from the connection id', () => {
    const { requirements, needsId } = setupRequirements(HEADER, 'main', 'personal');

    expect(needsId).toBe(false);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.ref).toBe('thing/main');
    expect(requirements[0]?.scope).toBe('connection');
  });

  test('two prompts that share one ref produce one command, not two', () => {
    // The failure this prevents: two `secrets set` calls against `post/ada`,
    // the second overwriting the first, leaving a credential that is a password
    // where the transport expects `username:password`.
    const { requirements } = setupRequirements(BASIC, 'ada', 'personal');

    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.prompts).toEqual(['username', 'password']);
    expect(requirements[0]?.command).toContain('<username>:<password>');
  });

  test('a provider that authenticates to nothing needs nothing', () => {
    expect(setupRequirements(NO_AUTH, undefined, 'personal')).toEqual({
      requirements: [],
      needsId: false,
    });
  });

  test('needsId is true exactly when a per-account value has no id to derive from', () => {
    expect(setupRequirements(HEADER, undefined, 'personal').needsId).toBe(true);
    expect(setupRequirements(HEADER, 'main', 'personal').needsId).toBe(false);
    expect(setupRequirements(NO_AUTH, undefined, 'personal').needsId).toBe(false);
  });

  test('the emitted command names a ref the credential store accepts', () => {
    for (const manifest of [HEADER, BASIC]) {
      for (const requirement of setupRequirements(manifest, 'main', 'personal').requirements) {
        expect(() => assertValidSecretRef(requirement.ref)).not.toThrow();
        expect(requirement.command).toContain(`lanes link secrets set ${requirement.ref}`);
        expect(requirement.command).toContain('--profile personal');
      }
    }
  });
});

describe('missingRequirements', () => {
  test('reports only what the store does not already hold', async () => {
    const { requirements } = setupRequirements(HEADER, 'main', 'personal');
    const held = new Set(['thing/main']);

    const missing = await missingRequirements(requirements, {
      has: async (ref) => held.has(ref),
    });

    expect(missing).toEqual([]);

    held.clear();
    expect(await missingRequirements(requirements, { has: async () => false })).toHaveLength(1);
  });
});

describe('preflight', () => {
  const never = { has: async () => false };
  const always = { has: async () => true };

  test('refuses OAuth outright rather than opening a browser nobody is watching', async () => {
    const oauth = defineProvider({
      id: 'cloudy',
      name: 'Cloudy',
      version: '1.0.0',
      description: 'a provider that authorises in a browser',
      connector: { kind: 'mcp', endpoint: 'https://mcp.example.test' },
      auth: { kind: 'oauth', scopes: ['read'] },
    });

    const blocked = await preflight({
      manifest: oauth,
      connectionId: 'main',
      profile: 'personal',
      credentials: always,
      target: 'cloudy',
    });

    // `connect` would spawn a browser and then block on a loopback listener for
    // five minutes. An agent's shell times out first, taking the listener with
    // it, and the operator gets no token and no explanation.
    expect(blocked?.reason).toBe('needs_browser');
    expect(blocked?.then).toBe('lanes link connect cloudy --profile personal');
    expect(blocked?.needs).toEqual([]);
  });

  test('asks for an id before a per-account ref can be derived', async () => {
    const blocked = await preflight({
      manifest: HEADER,
      connectionId: undefined,
      profile: 'personal',
      credentials: never,
      target: 'thing',
    });

    expect(blocked?.reason).toBe('needs_id');
    expect(blocked?.then).toContain('--id <name>');
  });

  test('names every missing value at once, so one round trip is enough', async () => {
    const blocked = await preflight({
      manifest: BASIC,
      connectionId: 'ada',
      profile: 'personal',
      credentials: never,
      target: 'post',
    });

    expect(blocked?.reason).toBe('missing_credentials');
    expect(blocked?.needs.map((need) => need.ref)).toEqual(['post/ada']);
    expect(blocked?.then).toContain('--non-interactive');
  });

  test('nothing blocks it when the store already holds the value', async () => {
    expect(
      await preflight({
        manifest: HEADER,
        connectionId: 'main',
        profile: 'personal',
        credentials: always,
        target: 'thing',
      }),
    ).toBeNull();
  });
});
