import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '#profile';
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

  test('a pluggable auth strategy is expressible in YAML', () => {
    const manifest = parseManifest(`
id: bunq
name: bunq
connector:
  kind: http
  base_url: https://public-api.sandbox.bunq.com/v1
  openapi: ./bunq.json
auth:
  kind: strategy
  strategy: bunq
  credential_ref: bunq/api_key
`);

    expect(manifest.auth).toMatchObject({ kind: 'strategy', strategy: 'bunq' });
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
