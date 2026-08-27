import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '#profile';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import { loadProfileProviders, parseManifest } from './load.ts';
import { manifestTemplate } from './template.ts';

/**
 * The scalability claim of this milestone: a service nobody has integrated
 * costs a YAML file, not a pull request. These are the tests that hold it up.
 */

const roots: string[] = [];

/** Manifests are the profile's own, so a workspace here is a profile's directory. */
const PROFILE = 'personal';

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-manifests-'));
  roots.push(root);
  const directory = join(root, layout.providers(PROFILE));
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('a custom MCP server needs no code', () => {
  const manifest = `
id: acme
name: Acme
connector:
  kind: mcp
  endpoint: https://mcp.acme.com/mcp
auth:
  kind: oauth
  registration: dynamic
`;

  test('loads from the profile', async () => {
    const root = await workspaceWith({ 'acme.yaml': manifest });
    const [loaded] = await loadProfileProviders(root, PROFILE);

    expect(loaded?.manifest.id).toBe('acme');
    expect(loaded?.manifest.connector).toMatchObject({
      kind: 'mcp',
      endpoint: 'https://mcp.acme.com/mcp',
    });
    expect(loaded?.manifest.auth).toMatchObject({ kind: 'oauth', registration: 'dynamic' });
  });
});

describe('a custom REST API needs no code either', () => {
  test('accepts an OpenAPI source, operation filters, and a header credential', () => {
    const manifest = parseManifest(`
id: acme
name: Acme
connector:
  kind: http
  base_url: https://api.acme.com/v1
  openapi: https://api.acme.com/openapi.json
  operations:
    include: ["*Account*", "*Payment*"]
auth:
  kind: header
  header: X-API-Key
  credential_ref: acme/api_key
setup:
  docs: "Generate a key at https://acme.com/settings/api"
`);

    expect(manifest.connector).toMatchObject({
      kind: 'http',
      base_url: 'https://api.acme.com/v1',
    });
    expect(manifest.auth).toMatchObject({ kind: 'header', credential_ref: 'acme/api_key' });
    // The "how do I get that key" case, handled without any code.
    expect(manifest.setup?.docs).toContain('acme.com/settings/api');
  });

  /**
   * A strategy names code, and a declaration-only manifest is the case
   * `strategyFor` added the borrowing path for: a YAML file has no definition of
   * its own, so it reaches a registered provider's strategy by name. Which is
   * also the only way to point a connection at a vendor's sandbox, since a
   * built-in manifest's `options` are not the operator's to edit.
   *
   * Whether the name resolves is not a question this schema can answer — the
   * registry knows, and `refuseStrategy` is what says so.
   */
  test('a pluggable auth strategy is expressible in YAML', () => {
    const manifest = parseManifest(`
id: thing_sandbox
name: Thing Sandbox
connector:
  kind: http
  base_url: https://public-api.sandbox.example.com/v1
  openapi: ./thing.json
auth:
  kind: strategy
  strategy: thing
`);

    expect(manifest.auth).toMatchObject({ kind: 'strategy', strategy: 'thing' });
  });
});

describe('a manifest is held to the same rules as config', () => {
  test('rejects a credential value pasted in place of a reference', () => {
    // Someone writing their first manifest will reach for pasting the key
    // directly. This is what stops that becoming a secret in a file they commit.
    expect(() =>
      parseManifest(`
id: acme
name: Acme
connector: { kind: mcp, endpoint: https://mcp.acme.com/mcp }
auth:
  kind: header
  header: X-API-Key
  api_key: sk-proj-abc123XYZdefGHI456jklMNO
`),
    ).toThrow(/credential/i);
  });

  test('rejects a malformed manifest with the offending field named', () => {
    expect(() => parseManifest('id: Acme\nname: Acme\nconnector: { kind: mcp, endpoint: nope }')).toThrow(
      /connector|id/,
    );
  });

  test('rejects OAuth with manual registration and no way to supply the client', () => {
    // Otherwise the operator is told to authorise and has no idea what to give.
    expect(() =>
      parseManifest(`
id: acme
name: Acme
connector: { kind: mcp, endpoint: https://mcp.acme.com/mcp }
auth:
  kind: oauth
  registration: manual
  app: acme
`),
    ).toThrow(/setup prompts/);
  });

  test('rejects a local connector claiming to need auth', () => {
    expect(() =>
      parseManifest(`
id: acme
name: Acme
connector: { kind: local }
auth: { kind: bearer, credential_ref: acme/token }
`),
    ).toThrow(/auth "none"/);
  });

  test('reports unparseable YAML as such', () => {
    expect(() => parseManifest('id: acme\n  bad: [')).toThrow(/could not parse YAML/);
  });
});

describe('workspace loading', () => {
  test('an absent providers directory is the normal case, not an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-empty-'));
    roots.push(root);
    expect(await loadProfileProviders(root, PROFILE)).toEqual([]);
  });

  test('ignores non-YAML and example files', async () => {
    const root = await workspaceWith({
      'acme.yaml': 'id: acme\nname: Acme\nconnector: { kind: mcp, endpoint: https://mcp.acme.com/mcp }',
      'notes.md': 'not a manifest',
      'template.example.yaml': 'id: bad',
    });

    const loaded = await loadProfileProviders(root, PROFILE);
    expect(loaded.map((entry) => entry.manifest.id)).toEqual(['acme']);
  });

  test('names the file when one manifest is broken', async () => {
    const root = await workspaceWith({ 'broken.yaml': 'id: acme\nname: Acme' });
    await expect(loadProfileProviders(root, PROFILE)).rejects.toThrow(/broken\.yaml/);
  });
});

describe('a relative openapi path', () => {
  test('resolves against the manifest, not the working directory', async () => {
    // What `docs/detailed/creating-a-provider.md` tells an operator to write. It used to
    // resolve against the *process* cwd, so it worked only when `lanes-link` was
    // run from the right folder and failed with a bare ENOENT everywhere else.
    const root = await workspaceWith({
      'mything.yaml':
        'id: mything\nname: My Thing\n' +
        'connector: { kind: http, base_url: https://api.mything.test, openapi: ./mything.json }',
    });

    const [loaded] = await loadProfileProviders(root, PROFILE);
    const connector = loaded!.manifest.connector as { openapi: string };

    expect(connector.openapi).toBe(join(root, layout.providers(PROFILE), 'mything.json'));
  });

  test('a URL is left alone', async () => {
    const root = await workspaceWith({
      'remote.yaml':
        'id: remote\nname: Remote\n' +
        'connector: { kind: http, base_url: https://api.remote.test, openapi: https://api.remote.test/openapi.json }',
    });

    const [loaded] = await loadProfileProviders(root, PROFILE);

    expect((loaded!.manifest.connector as { openapi: string }).openapi).toBe(
      'https://api.remote.test/openapi.json',
    );
  });
});

describe('the starting templates are themselves valid', () => {
  test.each(['mcp', 'http', 'imap', 'dav', 'fs'] as const)('%s template parses', (kind) => {
    expect(() => parseManifest(manifestTemplate(kind))).not.toThrow();
  });
});

/**
 * A workspace in a bucket, which is what a deployed revision is handed.
 *
 * The keys are the same ones the filesystem store uses, because that is the
 * property the fix turns on: the manifest is addressed by key either way, and
 * only the store behind it changes.
 */
async function bucketWith(files: Record<string, string>): Promise<BlobStore> {
  const store = createMemoryBlobStore();
  for (const [name, contents] of Object.entries(files)) {
    await store.put(`${layout.providers(PROFILE)}/${name}`, new TextEncoder().encode(contents));
  }
  return store;
}

describe('a workspace in a bucket', () => {
  const manifest =
    'id: acme\nname: Acme\nconnector: { kind: mcp, endpoint: https://mcp.example.com/mcp }\n';

  /**
   * The bug this describe block exists for.
   *
   * `loadProfileProviders` used `join(workspaceRoot, …)` against `node:fs`, and
   * `join('gs://b', 'data/p/providers.d')` is `gs:/b/data/p/providers.d` — so
   * `readdir` threw ENOENT and the catch reported an empty list, which is
   * indistinguishable from a workspace that has no manifests. The manifest was
   * uploaded, the read grant covered it, and it silently did not exist.
   */
  test('loads the manifests a deployed revision was given', async () => {
    const store = await bucketWith({ 'acme.yaml': manifest });
    const loaded = await loadProfileProviders('gs://your-bucket', PROFILE, store);

    expect(loaded.map((entry) => entry.manifest.id)).toEqual(['acme']);
  });

  test('names the manifest by its bucket URL, so a refusal can be acted on', async () => {
    const store = await bucketWith({ 'acme.yaml': manifest });
    const [loaded] = await loadProfileProviders('gs://your-bucket', PROFILE, store);

    expect(loaded?.path).toBe(`gs://your-bucket/${layout.providers(PROFILE)}/acme.yaml`);
  });

  test('applies the same filters as a directory does', async () => {
    const store = await bucketWith({
      'acme.yaml': manifest,
      'notes.md': 'not a manifest',
      'template.example.yaml': 'id: bad',
    });

    const loaded = await loadProfileProviders('gs://your-bucket', PROFILE, store);
    expect(loaded.map((entry) => entry.manifest.id)).toEqual(['acme']);
  });

  test('a spec beside a manifest is not itself a manifest', async () => {
    // A relative `openapi:` points at a sibling, and `upload.ts` carries it into
    // the same prefix. Listing a prefix returns both; only one is a declaration.
    const store = await bucketWith({
      'acme.yaml':
        'id: acme\nname: Acme\n' +
        'connector: { kind: http, base_url: https://api.example.com, openapi: https://api.example.com/openapi.json }\n',
    });
    await store.put(
      `${layout.providers(PROFILE)}/specs/acme.json`,
      new TextEncoder().encode('{}'),
    );

    const loaded = await loadProfileProviders('gs://your-bucket', PROFILE, store);
    expect(loaded.map((entry) => entry.manifest.id)).toEqual(['acme']);
  });

  test('refuses a relative openapi path rather than resolving it into nothing', async () => {
    // There is no directory to resolve against, and the generator wants a file
    // or a URL. Left to itself this surfaces as a discovery failure the runtime
    // swallows, leaving a provider with no capabilities and nothing saying why.
    const store = await bucketWith({
      'acme.yaml':
        'id: acme\nname: Acme\n' +
        'connector: { kind: http, base_url: https://api.example.com, openapi: ./acme.json }\n',
    });

    await expect(loadProfileProviders('gs://your-bucket', PROFILE, store)).rejects.toThrow(
      /relative path.*publish the spec at a URL/s,
    );
  });
});
