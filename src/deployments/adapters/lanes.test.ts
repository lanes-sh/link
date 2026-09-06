import { describe, expect, test } from 'bun:test';
import { describeBlobStoreContract } from '#stores/blobs/conformance.ts';
import { createLanesBlobStore } from './lanes.ts';

/**
 * A workspace Lanes hosts, reached over the API rather than a bucket.
 *
 * `gs://` needs the operator's own Google credentials, which is right for a
 * workspace in their project and impossible for one in ours: handing a laptop
 * bucket credentials to Lanes' storage would give it every tenant's bytes. So
 * the managed scheme addresses a workspace through the API, which already knows
 * who is calling and which workspaces they are a member of.
 *
 * The point of running the shared contract against it is that the CLI, the
 * control plane and the runtime all read config through `BlobStore`. An adapter
 * that satisfied most of the contract would fail somewhere none of them think
 * about storage at all.
 */

const API = 'https://api.example.com';

/** The API's file routes, in memory. */
function fakeApi() {
  const files = new Map<string, { data: Uint8Array; contentType?: string; modifiedAt: Date }>();
  const seen: { authorization: string | null }[] = [];

  const route = (url: URL): { workspace: string; kind: string } | null => {
    const parts = url.pathname.split('/').filter(Boolean);
    // v1 / workspaces / <ws> / link / files / <kind>
    if (parts.length !== 6) return null;
    if (parts[0] !== 'v1' || parts[1] !== 'workspaces' || parts[3] !== 'link') return null;
    if (parts[4] !== 'files') return null;
    return { workspace: parts[2] ?? '', kind: parts[5] ?? '' };
  };

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    seen.push({ authorization: request.headers.get('authorization') });

    const placed = route(url);
    if (!placed) return new Response('no such route', { status: 404 });

    const scope = `${placed.workspace}::`;

    if (placed.kind === 'list') {
      const prefix = scope + (url.searchParams.get('prefix') ?? '');
      return Response.json({
        files: [...files.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, held]) => ({
            key: key.slice(scope.length),
            size: held.data.byteLength,
            ...(held.contentType ? { contentType: held.contentType } : {}),
            modifiedAt: held.modifiedAt.toISOString(),
          })),
      });
    }

    if (placed.kind !== 'object') return new Response('no such route', { status: 404 });
    const key = scope + (url.searchParams.get('key') ?? '');

    if (request.method === 'PUT') {
      files.set(key, {
        data: new Uint8Array(await request.arrayBuffer()),
        ...(request.headers.get('content-type')
          ? { contentType: request.headers.get('content-type') as string }
          : {}),
        modifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      return new Response(null, { status: 204 });
    }

    if (request.method === 'DELETE') {
      files.delete(key);
      return new Response(null, { status: 204 });
    }

    const held = files.get(key);
    if (!held) return new Response(null, { status: 404 });
    if (request.method === 'HEAD') return new Response(null, { status: 200 });
    return new Response(held.data, {
      status: 200,
      headers: { 'content-type': held.contentType ?? 'application/octet-stream' },
    });
  };

  return { fetch, files, seen };
}

const store = (workspace: string, api: ReturnType<typeof fakeApi>) =>
  createLanesBlobStore({
    apiUrl: API,
    workspace,
    tokens: { async token() { return 'id-token'; } },
    fetch: api.fetch,
  });

describeBlobStoreContract('lanes', async () => {
  const api = fakeApi();
  return {
    open: () => store('ws-aaa', api),
    dispose: async () => {
      api.files.clear();
    },
  };
});

describe('lanes: the workspace is the scope', () => {
  test('two workspaces on one API do not see each other', async () => {
    const api = fakeApi();
    const first = store('ws-aaa', api);
    const second = store('ws-bbb', api);

    await first.put('connections.yaml', new TextEncoder().encode('first'));
    await second.put('connections.yaml', new TextEncoder().encode('second'));

    expect(new TextDecoder().decode(await first.get('connections.yaml') ?? undefined)).toBe('first');
    expect(await second.list()).toEqual([
      expect.objectContaining({ key: 'connections.yaml' }),
    ]);
  });

  test('presents a credential on every request', async () => {
    const api = fakeApi();
    await store('ws-aaa', api).get('connections.yaml');

    expect(api.seen.at(-1)?.authorization).toBe('Bearer id-token');
  });

  test('says which workspace was refused rather than reporting a bare status', async () => {
    const api = fakeApi();
    const refusing = createLanesBlobStore({
      apiUrl: API,
      workspace: 'ws-aaa',
      tokens: { async token() { return 'id-token'; } },
      fetch: async () => new Response('nope', { status: 403 }),
    });

    await expect(refusing.get('connections.yaml')).rejects.toThrow(/ws-aaa/);
  });
});

describe('lanes: the workspace root', () => {
  test('a root naming no workspace is refused', async () => {
    const { lanesWorkspaceFrom } = await import('./lanes.ts');
    expect(() => lanesWorkspaceFrom('lanes://')).toThrow(/workspace/i);
    expect(() => lanesWorkspaceFrom('lanes:///')).toThrow(/workspace/i);
  });

  test('reads the workspace out of the root', async () => {
    const { lanesWorkspaceFrom } = await import('./lanes.ts');
    expect(lanesWorkspaceFrom('lanes://ws-aaa')).toBe('ws-aaa');
    expect(lanesWorkspaceFrom('lanes://ws-aaa/')).toBe('ws-aaa');
  });
});

describe('lanes: where the credential comes from', () => {
  test('a store built without one uses whatever the process registered', async () => {
    const { useLanesCredentials } = await import('./lanes.ts');
    const api = fakeApi();
    useLanesCredentials({ async token() { return 'ambient-token'; } });

    await createLanesBlobStore({ apiUrl: API, workspace: 'ws-aaa', fetch: api.fetch }).get('x.yaml');

    expect(api.seen.at(-1)?.authorization).toBe('Bearer ambient-token');
    useLanesCredentials(null);
  });

  test('says what to do when nothing registered one', async () => {
    const { useLanesCredentials } = await import('./lanes.ts');
    useLanesCredentials(null);
    const api = fakeApi();

    // The adapter cannot read the signed-in session itself: `deployments` may
    // not import `auth`, and that rule is what keeps a storage backend from
    // growing an opinion about identity. So the process registers one, and a
    // process that did not gets a sentence rather than a 401.
    await expect(
      createLanesBlobStore({ apiUrl: API, workspace: 'ws-aaa', fetch: api.fetch }).get('x.yaml'),
    ).rejects.toThrow(/lanes auth login|no credential/i);
  });

  test('an explicitly passed source wins over the registered one', async () => {
    const { useLanesCredentials } = await import('./lanes.ts');
    const api = fakeApi();
    useLanesCredentials({ async token() { return 'ambient-token'; } });

    await createLanesBlobStore({
      apiUrl: API,
      workspace: 'ws-aaa',
      tokens: { async token() { return 'explicit-token'; } },
      fetch: api.fetch,
    }).get('x.yaml');

    expect(api.seen.at(-1)?.authorization).toBe('Bearer explicit-token');
    useLanesCredentials(null);
  });
});
