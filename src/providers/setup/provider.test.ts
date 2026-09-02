import { describe, expect, test } from 'bun:test';
import { defineProvider, type Capability, type ProviderContext } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { planAll } from './plan.ts';
import { createSetupProvider } from './provider.ts';

/**
 * The read-only setup surface.
 *
 * Two properties carry the whole design, and both are structural rather than
 * about wording:
 *
 * - It reports only what the caller may already reach. A connection filtered out
 *   by policy must be indistinguishable from one that was never made, or
 *   describing setup becomes an oracle on what is denied (ADR-007).
 * - Nothing here writes. The capability list holding exactly two reads is the
 *   claim, so it is asserted rather than left to review.
 */

const CATALOGUE = [
  defineProvider({
    id: 'thing',
    name: 'Thing',
    version: '1.0.0',
    description: 'a provider with one per-account key',
    connector: { kind: 'http', base_url: 'https://example.test', openapi: './x.json' },
    auth: { kind: 'header', header: 'X-Key' },
    setup: {
      steps: ['Make a key'],
      prompts: [
        {
          key: 'key',
          label: 'API key',
          secret: true,
          scope: 'connection',
          field: 'value',
        },
      ],
    },
  }),
  defineProvider({
    id: 'shared',
    name: 'Shared',
    version: '1.0.0',
    description: 'a provider whose client is stored once per profile',
    connector: { kind: 'mcp', endpoint: 'https://mcp.example.test' },
    auth: { kind: 'oauth', scopes: ['read'], app: 'shared', registration: 'manual' },
    setup: {
      steps: ['Register a client'],
      prompts: [
        {
          key: 'client_secret',
          label: 'OAuth client secret',
          secret: true,
          scope: 'shared',
          field: 'value',
          credential_ref: 'shared/client_secret',
        },
      ],
    },
  }),
];

function capabilities(options: Parameters<typeof createSetupProvider>[0]): Capability[] {
  return [...createSetupProvider(options).capabilities];
}

function tool(name: string, options: Parameters<typeof createSetupProvider>[0]): Capability {
  const found = capabilities(options).find((capability) => capability.name === name);
  if (!found) throw new Error(`no capability "${name}"`);
  return found;
}

/** Only `connection.key` is read by these handlers. */
const context = { connection: { key: 'lanes_setup.main', id: 'main', provider: 'lanes_setup' } } as
  unknown as ProviderContext;

async function textOf(capability: Capability, input: unknown): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (capability as any).handler(input, context)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return result.content.map((part) => part.text).join('\n');
}

describe('the surface is read-only', () => {
  test('offers exactly two capabilities, and both are tools', () => {
    const list = capabilities({ profile: 'personal', target: 'local' });

    // The absence of a write is the design, so it is asserted rather than
    // reviewed. A third capability here should fail until somebody has argued
    // for it against ADR-007.
    expect(list.map((capability) => capability.name).sort()).toEqual(['overview', 'provider']);
    expect(list.every((capability) => capability.kind === 'tool')).toBe(true);
  });

  test('declares no write bundle', () => {
    const bundles = createSetupProvider({ profile: 'personal', target: 'local' }).manifest.bundles ?? [];

    expect(bundles.map((bundle) => bundle.name)).toEqual(['read']);
  });
});

describe('lanes_setup.overview', () => {
  test('names only the connections it was given', async () => {
    const text = await textOf(tool('overview', {
      profile: 'personal',
      target: 'local',
      catalogue: CATALOGUE,
      reachable: () => [{ key: 'thing.main', provider: 'thing', account: 'you@example.test' }],
    }), {});

    expect(text).toContain('thing.main');
    expect(text).toContain('you@example.test');
  });

  test('a provider filtered out by policy reads as merely available', async () => {
    // The oracle test, at the unit level. `reachable()` is what policy filters,
    // so a denied `thing` arrives here as an empty list — and the rendering must
    // not distinguish that from a `thing` nobody ever connected.
    const denied = await textOf(tool('overview', {
      profile: 'personal',
      target: 'local',
      catalogue: CATALOGUE,
      reachable: () => [],
    }), {});

    const never = await textOf(tool('overview', {
      profile: 'personal',
      target: 'local',
      catalogue: CATALOGUE,
      reachable: () => [],
    }), {});

    expect(denied).toBe(never);
    expect(denied).not.toContain('denied');
    expect(denied).toContain('thing');
  });

  test('asks for what is reachable per call, not once at construction', async () => {
    let connections: { key: string; provider: string; account: string }[] = [];
    const capability = tool('overview', {
      profile: 'personal',
      target: 'local',
      catalogue: CATALOGUE,
      reachable: () => connections,
    });

    expect(await textOf(capability, {})).toContain('No accounts are connected');

    connections = [{ key: 'thing.main', provider: 'thing', account: 'you@example.test' }];
    expect(await textOf(capability, {})).toContain('thing.main');
  });

  test('points at sibling profiles by name only', async () => {
    const text = await textOf(tool('overview', {
      profile: 'personal',
      target: 'local',
      profiles: ['personal', 'work'],
      catalogue: CATALOGUE,
    }), {});

    expect(text).toContain('work');
    expect(text).not.toContain('personal, work');
  });

  /**
   * "Connect another Gmail account" is the question this surface exists to
   * answer, and it used to have no answer: a provider was filtered out of the
   * overview entirely once it had one connection, so an agent read the list,
   * saw no path, and invented one.
   */
  describe('a provider that already has an account', () => {
    /** `thing` holds a per-account key; `local` holds no account at all. */
    const MIXED = [
      ...CATALOGUE,
      defineProvider({
        id: 'local',
        name: 'Local',
        version: '1.0.0',
        description: 'a provider holding no third-party account',
        connector: { kind: 'local' },
        auth: { kind: 'none' },
      }),
    ];

    const connectedThing = {
      profile: 'personal',
      target: 'local',
      catalogue: MIXED,
      reachable: () => [{ key: 'thing.main', provider: 'thing', account: 'you@example.test' }],
    };

    test('is still offered for a further account', async () => {
      const text = await textOf(tool('overview', connectedThing), {});

      expect(text).toContain('able to hold a further account');
      expect(text).toContain('thing');
    });

    test('is not listed as if it were unconnected', async () => {
      const text = await textOf(tool('overview', connectedThing), {});

      // It belongs under one heading or the other, never both — "could be
      // connected" about a live account is just wrong.
      //
      // Both headings are asserted before the window is cut from them. A missing
      // one makes `indexOf` return -1, and the slice that follows would still
      // produce a string that passes the real assertion — so the test would go
      // on reporting that a renamed heading was fine.
      const from = text.indexOf('Could be connected:');
      const to = text.indexOf('Already connected, and');
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);

      expect(text.slice(from, to)).not.toContain('thing');
    });

    test('a provider holding no account is never offered a second one', async () => {
      const text = await textOf(tool('overview', {
        profile: 'personal',
        target: 'local',
        catalogue: MIXED,
        reachable: () => [{ key: 'local.main', provider: 'local', account: 'Local' }],
      }), {});

      // The owner layer — memory, skills, vault, setup — is exactly this shape.
      // "Connect a second memory" is meaningless and would be acted on.
      expect(text).not.toContain('able to hold a further account');
    });

    test('a denied provider is not named there either', async () => {
      // The oracle again, on the new line specifically: `reachable()` is the
      // policy-filtered set, so a denied `thing` arrives as an empty list and
      // must read as never-connected rather than as "connected, add another".
      const denied = await textOf(tool('overview', {
        profile: 'personal',
        target: 'local',
        catalogue: MIXED,
        reachable: () => [],
      }), {});

      expect(denied).not.toContain('able to hold a further account');
    });

    test('still discloses no filesystem path', async () => {
      const text = await textOf(tool('overview', connectedThing), {});

      expect(text).not.toContain('/');
    });
  });
});

describe('lanes_setup.provider', () => {
  const options = { profile: 'personal', target: 'local', catalogue: CATALOGUE };

  test('emits a command naming the profile it was stamped with', async () => {
    const text = await textOf(tool('provider', options), { id: 'thing' });

    // The handler cannot read the profile from its arguments — the routing
    // argument is stripped before dispatch — so this is the only thing holding
    // the stamped value to the emitted command.
    expect(text).toContain('lanes link connect thing --profile personal');
  });

  test('renders the same command `setup plan` would, for every shipped provider', async () => {
    // The anti-drift assertion. `lanes link setup plan` renders `planFor` for a
    // terminal and this renders it for a model, and the model's job is to hand
    // a person something to paste — so the two must never diverge on the one
    // line that matters. Derived from `planFor` rather than written out, so it
    // keeps holding when the wording around it changes.
    const context = { profile: 'personal', target: 'local', connections: [] };

    for (const plan of planAll(PROVIDER_MANIFESTS, context)) {
      const text = await textOf(
        tool('provider', { profile: 'personal', target: 'local', catalogue: PROVIDER_MANIFESTS }),
        { id: plan.id },
      );

      expect(text).toContain(plan.command);
    }
  });

  test('never discloses a credential reference for a shared secret', async () => {
    const text = await textOf(tool('provider', options), { id: 'shared' });

    // The label is what a person needs; the ref names a key in the credential
    // store and buys them nothing.
    expect(text).toContain('OAuth client secret');
    expect(text).not.toContain('shared/client_secret');
  });

  test('says when a browser is needed, since that is what an agent cannot do', async () => {
    expect(await textOf(tool('provider', options), { id: 'shared' })).toContain('opens a browser');
    expect(await textOf(tool('provider', options), { id: 'thing' })).not.toContain('opens a browser');
  });

  test('says the command adds an account rather than replacing the ones there', async () => {
    const text = await textOf(
      tool('provider', {
        ...options,
        reachable: () => [{ key: 'thing.main', provider: 'thing', account: 'you@example.test' }],
      }),
      { id: 'thing' },
    );

    // Otherwise the reader has a list of live accounts and a command, and no
    // way to tell whether running it adds one or overwrites them.
    expect(text).toContain('Already connected here: thing.main');
    expect(text).toContain('adds another account rather than replacing');
  });

  test('an unknown id is an error result, not a thrown exception', async () => {
    // A throw becomes a protocol error and loses the connection; an error result
    // is something the caller can read and act on.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool('provider', options) as any).handler({ id: 'nope' }, context);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('lanes_setup_overview');
  });

  test('records the provider id in the audit log, and nothing else verbatim', () => {
    const capability = tool('provider', options);

    // A log that cannot say which provider was asked about answers very little;
    // the connection label is the caller's own text and is type-marked.
    expect(capability.redact?.({ id: 'thing', connection: 'personal-account' })).toEqual({
      id: 'thing',
      connection: '<string:16>',
    });
  });
});
