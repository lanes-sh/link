import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProvider, type DiscoveredCapability } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { openRuntime } from '../runtime.ts';
import { capabilityDiff, discoveryProbe, isEmptyDiff } from './discovery.ts';

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

const PROFILE = `contract: 1

instance:
  profile: personal
  default_target: local

targets:
  local:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/files }

policy:
  allow: ['*']
`;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-discovery-'));
  roots.push(root);
  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'lanes-link.yaml'), 'contract: 1\ndefault_profile: personal\n');
  await writeFile(join(root, 'profiles', 'personal.yaml'), PROFILE);
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

    let runtime = await openRuntime({ target: 'local' });
    try {
      await runtime.state.kv.set('discovery', 'drive', JSON.stringify(stale));
    } finally {
      await runtime.close();
    }

    runtime = await openRuntime({ target: 'local' });
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
    let runtime = await openRuntime({ target: 'local' });
    try {
      await runtime.state.kv.set(
        'discovery',
        'gmail',
        JSON.stringify([capability('users.drafts.create'), capability('users.messages.list')]),
      );
    } finally {
      await runtime.close();
    }

    runtime = await openRuntime({ target: 'local' });
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
