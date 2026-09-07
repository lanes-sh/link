import { afterEach, describe, expect, test } from 'bun:test';
import { configSchema } from '#profile';
import { targetSchema } from '#profile/schema.ts';
import { useLanesCredentials } from './adapters/lanes.ts';
import { openSecrets, openStorage } from './target.ts';
import type { SecretStore } from '#secrets';

/**
 * Declaring a workspace Lanes hosts.
 *
 * The adapter and the credential namespace exist; this is what makes them
 * reachable from a `workspaces.yaml`, which is the only way anything the
 * operator writes can select them. An adapter no config can name is an adapter
 * nothing exercises.
 */

const config = configSchema.parse({
  contract: 5,
  instance: { profile: 'personal' },
  grants: [],
  members: [],
});

const declared = (storage: Record<string, unknown>, credentials?: Record<string, unknown>) =>
  targetSchema.parse({
    credentials: credentials ?? { adapter: 'gcp-secret-manager', project: 'my-project' },
    storage,
  });

afterEach(() => {
  useLanesCredentials(null);
});

describe('a managed storage target', () => {
  test('addresses the API for the workspace it declares', async () => {
    const seen: string[] = [];
    useLanesCredentials({ async token() { return 'id-token'; } });

    const storage = await openStorage(
      {
        declared: declared({ adapter: 'lanes', workspace: 'ws-aaa' }),
        config,
        root: 'lanes://ws-aaa',
        target: 'managed',
      },
      {} as SecretStore,
    );

    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url instanceof Request ? url.url : url));
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;

    try {
      await storage().put('memory/main/one.md', new Uint8Array([1]));
    } finally {
      globalThis.fetch = real;
    }

    expect(seen[0]).toContain('/v1/workspaces/ws-aaa/link/files/object');
    // The profile's own area, exactly as the bucket adapters scope it.
    expect(decodeURIComponent(seen[0] ?? '')).toContain('profiles/personal/memory/main/one.md');
  });

  test('refuses to open without a workspace, naming the field', async () => {
    await expect(
      openStorage(
        {
          declared: declared({ adapter: 'lanes' }),
          config,
          root: 'lanes://ws-aaa',
          target: 'managed',
        },
        {} as SecretStore,
      ),
    ).rejects.toThrow(/workspaces\.managed\.storage\.workspace/);
  });
});

describe('a managed credential target', () => {
  test('scopes references to the namespace it declares', async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url instanceof Request ? url.url : url));
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    process.env['GOOGLE_ACCESS_TOKEN'] = 'test-token';

    try {
      const secrets = await openSecrets({
        declared: declared(
          { adapter: 'lanes', workspace: 'ws-aaa' },
          { adapter: 'gcp-secret-manager', project: 'my-project', namespace: 'ws-aaa' },
        ),
        root: 'lanes://ws-aaa',
        target: 'managed',
      });

      await secrets.get('tokens/tok1');
    } finally {
      globalThis.fetch = real;
      delete process.env['GOOGLE_ACCESS_TOKEN'];
    }

    // Without the namespace this is `tokens__tok1`, which every other workspace
    // in the project also writes.
    expect(seen[0]).toContain('/secrets/ws-aaa__tokens__tok1/');
  });
});
