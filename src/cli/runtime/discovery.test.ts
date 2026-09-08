import { workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProvider, type DiscoveredCapability } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { openRuntime } from '../runtime.ts';
import { capabilityDiff, discoveryProbe, isEmptyDiff, primeDiscovery } from './discovery.ts';
import { ProviderRegistry } from '#registry';
import type { RuntimeState } from '#stores/state';
import { DISCOVERY_NAMESPACE } from '#stores/state';

/**
 * The cache is not the authority for a document we ship.
 *
 * `connect` used to be the only writer of the discovery cache, so what the
 * endpoint served was whatever the operator's last consent screen happened to
 * see. Drive's committed spec carried nine operations and the endpoint served
 * six; Gmail served a `drafts.create` that had been deleted from the spec for a
 * documented safety reason, while the `specs.test.ts` guard against exactly that
 * collision stayed green — because the guard reads the spec and the endpoint
 * reads the cache.
 *
 * These tests pin the property that closes it: for a provider whose OpenAPI
 * document is committed here, the spec wins and the cache is not consulted.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

const PROFILE = `contract: 5

instance:
  profile: personal

policy:
  allow: ['*']
`;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-discovery-'));
  roots.push(root);
  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local'], {defaultProfile: 'personal'}));
  await writeProfileFixture(root, 'personal', PROFILE);
  process.env['LANES_LINK_HOME'] = root;
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const capability = (name: string): DiscoveredCapability => ({
  name,
  description: `The ${name} capability.`,
  inputSchema: { type: 'object', properties: {} },
});

describe('a committed spec outranks the cache', () => {
  test('a stale drive cache does not hide the operations the spec carries', async () => {
    await workspace();

    // Exactly what the endpoint was serving: the six read operations, missing
    // the three writes that make a file movable, copyable, and trashable.
    const stale = [
      'about.get',
      'files.list',
      'files.get',
      'files.export',
      'files.create',
      'permissions.list',
    ].map(capability);

    let runtime = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      await runtime.state.kv.set(DISCOVERY_NAMESPACE, 'drive', JSON.stringify(stale));
    } finally {
      await runtime.close();
    }

    runtime = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      const names = (runtime.registry.discovered('drive') ?? []).map((entry) => entry.name);
      expect(names).toContain('files.update');
      expect(names).toContain('files.copy');
      expect(names).toContain('permissions.create');
      expect(names.length).toBe(9);
    } finally {
      await runtime.close();
    }
  });

  test('a capability deleted from the spec stops being served', async () => {
    await workspace();

    // `drafts.create` was removed deliberately — it duplicates the authored
    // `send_message` and takes a base64url `raw` no model can assemble for an
    // attachment. A cache written before that change kept serving it.
    let runtime = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      await runtime.state.kv.set(
        DISCOVERY_NAMESPACE,
        'gmail',
        JSON.stringify([capability('users.drafts.create'), capability('users.messages.list')]),
      );
    } finally {
      await runtime.close();
    }

    runtime = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      const names = (runtime.registry.discovered('gmail') ?? []).map((entry) => entry.name);
      expect(names).not.toContain('users.drafts.create');
      expect(names).toContain('users.drafts.delete');
    } finally {
      await runtime.close();
    }
  });
});

describe('what a probe costs', () => {
  test('a provider shipping its own document is free to re-derive', () => {
    const drive = PROVIDER_MANIFESTS.find((manifest) => manifest.id === 'drive')!;
    expect(discoveryProbe(drive)?.cost).toBe('offline');
  });

  test('a spec fetched from a URL is not, so it keeps the cache', () => {
    // `providers/custom/template.ts` documents this as a supported shape. If it
    // were probed as `offline` the boot path would grow a network fetch.
    const remote = defineProvider({
      id: 'acme',
      name: 'Acme',
      connector: { kind: 'http', base_url: 'https://api.acme.com', openapi: 'https://api.acme.com/openapi.json' },
      auth: { kind: 'none' },
    });
    expect(discoveryProbe(remote)).toBeUndefined();
  });

  test('a session-shaped provider reports its cost rather than being probed for free', () => {
    const mail = PROVIDER_MANIFESTS.find((manifest) => manifest.id === 'icloud_mail')!;
    // No connector supplied: there is nothing to probe with, so no probe.
    expect(discoveryProbe(mail)).toBeUndefined();

    const stub = {
      kind: 'imap' as const,
      discover: async () => [capability('list_mailboxes')],
      invoke: async () => ({ content: [] }),
    };
    expect(discoveryProbe(mail, stub as never)?.cost).toBe('session');
  });

  test('authored capabilities are the definition, not something discovered', () => {
    const local = PROVIDER_MANIFESTS.find((manifest) => manifest.connector.kind === 'local');
    if (local) expect(discoveryProbe(local)).toBeUndefined();
  });
});

describe('capabilityDiff', () => {
  test('names what appeared, what went, and what merely changed shape', () => {
    const before = [capability('a'), capability('b'), capability('c')];
    const after: DiscoveredCapability[] = [
      capability('a'),
      { ...capability('b'), description: 'Now says something else.' },
      capability('d'),
    ];

    const diff = capabilityDiff(before, after);
    expect(diff.added).toEqual(['d']);
    expect(diff.removed).toEqual(['c']);
    expect(diff.changed).toEqual(['b']);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  test('a schema change counts, which is the case a name diff cannot see', () => {
    const before = [capability('a')];
    const after = [{ ...capability('a'), inputSchema: { type: 'object', properties: { q: {} } } }];
    expect(capabilityDiff(before, after).changed).toEqual(['a']);
  });

  test('identical sets are empty', () => {
    const set = [capability('a'), capability('b')];
    expect(isEmptyDiff(capabilityDiff(set, [...set]))).toBe(true);
  });
});

/**
 * The cache reads that stand between a cold instance and its open port.
 *
 * `primeDiscovery` runs before the endpoint binds, once per profile, over every
 * provider the catalogue registers rather than every one the operator
 * connected. Serially that is of the order of eighty round trips against a
 * bucket, and it was the largest single term in a ten-second cold start.
 *
 * Concurrency is the fix and it is invisible in the result — the registry ends
 * up holding the same thing either way — so it is asserted directly, against a
 * store that records how many reads were in flight at once.
 */
describe('priming discovery', () => {
  /** A store that answers slowly enough to overlap, and counts the overlap. */
  function countingState(): { state: RuntimeState; peak: () => number; order: () => string[] } {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];

    const kv = {
      get: async (_namespace: string, key: string): Promise<string | null> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        order.push(key);
        await Bun.sleep(5);
        inFlight -= 1;
        return null;
      },
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
      clearNamespace: async () => {},
    };

    return {
      state: { kv, connections: {}, cursors: {} } as unknown as RuntimeState,
      peak: () => peak,
      order: () => order,
    };
  }

  /** `count` providers the cache has to be consulted for — no committed spec. */
  function registryOf(count: number): ProviderRegistry {
    const registry = new ProviderRegistry();

    for (let index = 0; index < count; index += 1) {
      registry.register(
        defineProvider({
          id: `probe_${index}`,
          name: `Probe ${index}`,
          summary: 'A provider whose capabilities are not derivable offline.',
          connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp' },
          auth: { kind: 'none' },
        }) as never,
      );
    }

    return registry;
  }

  test('reads the cache concurrently rather than one round trip at a time', async () => {
    const { state, peak } = countingState();

    await primeDiscovery(registryOf(40), state);

    // The bound is 16; the assertion is that it overlaps at all, because the
    // number is a tuning choice and "serial" is the regression.
    expect(peak()).toBeGreaterThan(1);
  });

  test('asks for every provider it could not derive, exactly once', async () => {
    const { state, order } = countingState();

    await primeDiscovery(registryOf(40), state);

    expect(order()).toHaveLength(40);
    expect(new Set(order()).size).toBe(40);
  });
});
