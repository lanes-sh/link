import { connectionsYaml, workspaceYaml } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIONS_FILE, layout } from '#profile';
import { createFileSecretStore } from '#secrets';
import { openSecretStoreFor, openRuntime, resolveProfile } from './runtime.ts';

/**
 * Which adapters a target opens.
 *
 * The milestone's claim is that the same config runs in more than one place
 * with only the target switched, so the interesting tests are the ones that
 * switch it: a cloud target and a local target built from one file, and the
 * refusals for a target naming an adapter that cannot be built.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

const PROFILE = `contract: 3

instance:
  profile: personal

grants:
  - { connection: memory.main, allow: ['memory.*'], deny: [] }
  - { connection: skills.main, allow: ['skills.*'], deny: [] }
  - { connection: vault.main, allow: ['vault.*'], deny: [] }
members: []
`;

/**
 * The adapter sets, in the workspace file rather than in the profile.
 *
 * Every one of these used to sit under `targets:` inside `personal.yaml`. They
 * moved out wholesale under ADR-052 — same adapters, same names, declared once
 * by the workspace that is them — which is exactly the shape this file is here
 * to exercise.
 */
const TARGETS = `contract: 3
default_profile: personal

workspaces:
  local:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/files }
  s3_no_bucket:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: s3 }
  s3_no_ref:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: s3,         bucket: lanes-link-demo }
  s3:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:
      adapter: s3
      bucket: lanes-link-demo
      endpoint: https://example.storage.supabase.co/storage/v1/s3
      access_key_id_ref: cloud/s3_access_key_id
      secret_access_key_ref: cloud/s3_secret_access_key
  gcp_no_project:
    credentials: { adapter: gcp-secret-manager }
    storage:     { adapter: filesystem, path: ./data/files }
  blob_vault:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/files }
    vault:       { adapter: blob }
`;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-runtime-'));
  roots.push(root);

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'lanes-link.yaml'), TARGETS);
  await writeFile(join(root, 'profiles', 'personal.yaml'), PROFILE);
  await writeFile(join(root, CONNECTIONS_FILE), connectionsYaml());

  process.env['LANES_LINK_HOME'] = root;
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('the local target', () => {
  test('opens the encrypted file and the filesystem', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      expect(runtime.target).toBe('local');
      // Migrated on open, so the state is usable rather than merely built.
      expect(await runtime.state.connections.list()).toEqual([]);
      await runtime.credentials.set('profile/token', 'llk_test');
      expect(await runtime.credentials.get('profile/token')).toBe('llk_test');
    } finally {
      await runtime.close();
    }
  });
});

describe('the owner layer follows the target — ADR-014', () => {
  test("skills load from the granted connection's directory — ADR-059", async () => {
    const root = await workspace();
    // Not `<root>/skills/`, which is where they lived while every profile
    // shared them, and not `data/<profile>/skills.d/` either — they follow the
    // skills *connection* a profile grants now (ADR-059). A skill left at
    // either old path loads for nobody, deliberately.
    await mkdir(join(root, layout.skills('main')), { recursive: true });
    await writeFile(
      join(root, layout.skills('main'), 'review-diff.md'),
      '---\ndescription: Review a diff\n---\nReview it.\n',
    );
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'stale.md'),
      '---\ndescription: Left at the old workspace path\n---\nIgnored.\n',
    );

    const runtime = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      expect(runtime.registry.capabilities().map((entry) => entry.id)).toContain(
        'skills.review-diff',
      );
      // The same store the provider reads, exposed so `lanes link skills` cannot drift
      // into a second spelling of the same layout.
      expect((await runtime.skills?.list())?.map((blob) => blob.key)).toEqual(['review-diff.md']);
      expect(runtime.registry.capabilities().map((entry) => entry.id)).not.toContain(
        'skills.stale',
      );
    } finally {
      await runtime.close();
    }
  });

  test('a file vault is the default, and writes beside the credential store', async () => {
    const root = await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      await runtime.vault.put('owner', { id: 'token', value: 'secret' });
      // Under the vault connection this profile grants (ADR-059), not under the
      // profile — a profile owns no bytes now, and two profiles granting the
      // same vault reach the same sealed document.
      expect(await Bun.file(join(root, 'data', 'vault.d', 'main.enc')).exists()).toBe(true);
      // Its own key, never the credential store's.
      expect(await Bun.file(join(root, 'data', 'vault.d', 'main.enc.key')).exists()).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  test('a blob vault goes to the target’s storage, so a deployment keeps it', async () => {
    // Before this, `createFileVaultStore` was unconditional: on Cloud Run every
    // item was written to a container filesystem the next revision discarded.
    const root = await workspace();
    process.env['LANES_LINK_VAULT_KEY'] = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');

    const runtime = await openRuntime({ profile: 'personal', target: 'blob_vault' });
    try {
      await runtime.vault.put('owner', { id: 'token', value: 'secret' });

      // `vault.d/<connection>.enc`, not a single `vault.enc`: one sealed
      // document per vault connection (ADR-059), and the blob adapter honours
      // that as the file adapter does. It used to write one document for every
      // vault connection in the workspace, which is the collision whose wrong
      // answer is a credential.
      expect(
        await Bun.file(join(root, 'data', 'files', 'vault.d', 'main.enc')).exists(),
      ).toBe(true);
      expect(await Bun.file(join(root, 'data', 'personal.vault.enc')).exists()).toBe(false);
    } finally {
      delete process.env['LANES_LINK_VAULT_KEY'];
      await runtime.close();
    }
  });
});

describe('refusals', () => {
  test('an s3 target with no bucket says so before reaching for a credential', async () => {
    await workspace();
    await expect(openRuntime({ profile: 'personal', target: 's3_no_bucket' })).rejects.toThrow(
      /storage\.bucket is required for the s3 adapter/,
    );
  });

  test('an s3 target with no key refs says the key is a credential', async () => {
    await workspace();
    await expect(openRuntime({ profile: 'personal', target: 's3_no_ref' })).rejects.toThrow(
      /access_key_id_ref is required for the s3 adapter/,
    );
  });

  test('an s3 target whose key refs are not stored says how to store them', async () => {
    await workspace();
    // The first-deploy failure an operator actually hits, and the requirement
    // of it: carry the command, not an S3 client's auth error.
    await expect(openRuntime({ profile: 'personal', target: 's3' })).rejects.toThrow(
      /is not in this target's secret store.*lanes link secrets set cloud\/s3_access_key_id/s,
    );
  });

  test('gcp-secret-manager without a project fails before any API call', async () => {
    await workspace();
    await expect(openRuntime({ profile: 'personal', target: 'gcp_no_project' })).rejects.toThrow(
      /credentials\.project is required/,
    );
  });

  test('an undeclared target is refused by name', async () => {
    const root = await workspace();
    const { config } = await resolveProfile({ profile: 'personal', target: 'local' });
    // The listing is the registry's, one target per line with where each lives —
    // it used to be one profile's `targets:` keys joined by commas (ADR-052).
    await expect(openSecretStoreFor(config, root, 'staging')).rejects.toThrow(
      /Target "staging" is not declared.*local.*s3/s,
    );
  });
});

describe('one credential store, two targets', () => {
  test('secrets push has a source and a destination without opening a state', async () => {
    const root = await workspace();
    const { config } = await resolveProfile({ profile: 'personal', target: 'local' });

    // `s3` names a bucket this machine cannot reach; its credential store still
    // opens, which is what lets `secrets push --to cloud` work before the cloud
    // target has ever been deployed.
    const from = await openSecretStoreFor(config, root, 'local');
    const to = await openSecretStoreFor(config, root, 's3');

    await from.set('gmail/main', 'refresh-token');
    expect(await to.get('gmail/main')).toBe('refresh-token');
  });
});

/**
 * There is no cross-adapter equivalence block here any more.
 *
 * It ran the same config against SQLite and Postgres and asserted the same
 * answer, which was the claim worth making while two implementations of one
 * contract existed. There is one now: state is objects in whatever `BlobStore`
 * the target opened, so `local` and `cloud` differ in the blob adapter and
 * nothing else. `#stores/blobs/conformance.ts` holds those to one contract,
 * and `#stores/state`'s own tests run over two of them.
 */
