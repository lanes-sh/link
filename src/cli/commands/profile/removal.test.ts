import { describe, expect, test } from 'bun:test';
import type { Config, TargetConfig } from '#profile';
import type { SecretRef, SecretStore } from '#secrets';
import type { BlobMetadata, BlobStore } from '#stores/blobs';
import { buildRegistry } from '../../runtime/registry.ts';
import {
  declaredRefs,
  removalPlan,
  renderPlan,
  type RemovalItem,
  type RemovalPlan,
} from './removal.ts';

/**
 * Which credentials a profile may have its removal delete.
 *
 * The question only looks trivial on a local target, where the profile owns a
 * file and the file is the boundary. In Secret Manager every profile deployed
 * to one project shares a flat namespace, so `list()` answers with other
 * profiles' credentials too — and deleting those is not recoverable.
 */

const registry = buildRegistry();

const target = (over: Partial<TargetConfig> = {}): TargetConfig =>
  ({
    credentials: { adapter: 'file' },
    storage: { adapter: 'filesystem' },
    ...over,
  }) as unknown as TargetConfig;

const config = (over: Partial<Config> = {}): Config =>
  ({
    contract: 1,
    instance: { profile: 'personal', default_target: 'local' },
    auth: { mode: 'bearer', token_ref: 'profile/token' },
    oauth_apps: {
      google: { client_id_ref: 'google/client_id', client_secret_ref: 'google/client_secret' },
    },
    connections: [{ id: 'someone', provider: 'gmail', account: 'someone@example.com' }],
    targets: { local: target() },
    policy: { allow: [] },
    ...over,
  }) as unknown as Config;

describe('declaredRefs', () => {
  test('covers the profile token, the connection, and the oauth client', () => {
    const refs = declaredRefs(config(), registry, target());

    expect(refs).toContain('profile/token');
    expect(refs).toContain('gmail/someone');
    expect(refs).toContain('google/client_id');
    expect(refs).toContain('google/client_secret');
  });

  test('the vault ref comes from the target, because that is where it is declared', () => {
    // `vaultTargetSchema` sits inside `targetSchema`. Two targets may seal the
    // same profile's items in different places, so reading this off the profile
    // would attach one target's vault to another's removal.
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), registry, sealed)).toContain('vault/document');
    expect(declaredRefs(config(), registry, target())).not.toContain('vault/document');
  });

  test('a secret adapter with no ref falls back to the documented default', () => {
    const sealed = target({ vault: { adapter: 'secret' } } as never);

    expect(declaredRefs(config(), registry, sealed)).toContain('vault/document');
  });

  test('a connection whose provider no longer resolves contributes nothing', () => {
    // Its secret is reported as untouched rather than guessed at. A guessed
    // `<provider>/<id>` in a shared namespace could name someone else's.
    const gone = config({
      connections: [{ id: 'x', provider: 'no_such_provider', account: 'x' }],
    } as never);

    const refs = declaredRefs(gone, registry, target());

    expect(refs).not.toContain('no_such_provider/x');
    expect(refs).toContain('profile/token');
  });

  test('an explicit credential_ref still counts when the manifest is gone', () => {
    // `credentialRefFor` is the single authority: the manifest answers first,
    // and the connection's own field is the answer when it gives none.
    const explicit = config({
      connections: [
        { id: 'x', provider: 'no_such_provider', account: 'x', credential_ref: 'mything/api_key' },
      ],
    } as never);

    expect(declaredRefs(explicit, registry, target())).toContain('mything/api_key');
  });

  test('returns each ref once, even when two connections share a client', () => {
    const two = config({
      connections: [
        { id: 'a', provider: 'gmail', account: 'a@example.com' },
        { id: 'b', provider: 'drive', account: 'b@example.com' },
      ],
    } as never);

    const refs = declaredRefs(two, registry, target());

    expect(refs.filter((ref) => ref === 'google/client_id')).toHaveLength(1);
    expect(refs).toContain('gmail/a');
    expect(refs).toContain('drive/b');
  });
});

// --- removalPlan -----------------------------------------------------------

function fakeSecrets(refs: string[]): SecretStore {
  const held = new Map(refs.map((ref) => [ref, 'value']));
  return {
    get: async (ref) => held.get(ref) ?? null,
    set: async (ref, value) => void held.set(ref, value),
    has: async (ref) => held.has(ref),
    delete: async (ref) => void held.delete(ref),
    list: async () => [...held.keys()] as SecretRef[],
  };
}

function fakeBlobs(keys: string[]): BlobStore {
  const held = new Set(keys);
  return {
    put: async (key) => void held.add(key),
    get: async () => null,
    has: async (key) => held.has(key),
    delete: async (key) => void held.delete(key),
    list: async () =>
      [...held].map((key) => ({ key, size: 0, modifiedAt: new Date(0) })) as BlobMetadata[],
  };
}

const ids = (plan: RemovalPlan, kind: RemovalItem['kind']): string[] =>
  plan.items.filter((item) => item.kind === kind).map((item) => item.id);

describe('removalPlan', () => {
  test('plans every declared target, and the workspace items exactly once', async () => {
    const two = config({
      targets: { local: target(), cloud: target({ storage: { adapter: 'gcs', bucket: 'your-bucket' } } as never) },
    } as never);

    const plan = await removalPlan(two, '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['state.kv/a']),
    });

    expect(plan.items.filter((i) => i.target === 'local')).not.toHaveLength(0);
    expect(plan.items.filter((i) => i.target === 'cloud')).not.toHaveLength(0);
    expect(ids(plan, 'config').filter((id) => !id.startsWith('profiles/'))).toHaveLength(1);
  });

  test('deletes secrets before blobs, because the file store is itself a blob', async () => {
    // `layout.credentials(p)` is `data/<p>/credentials.enc`, inside the blob
    // root `data/<p>`. Delete blobs first and the store the secret deletions
    // read through is gone.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['credentials.enc']),
    });

    const kinds = plan.items.filter((i) => i.target === 'local').map((i) => i.kind);
    expect(kinds.indexOf('secret')).toBeLessThan(kinds.indexOf('blob'));
  });

  test('the local config is the last item, because it is the record of where things are', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['a']),
    });

    expect(plan.items.at(-1)?.kind).toBe('config');
  });

  test('a ref the profile does not declare is reported, never planned', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets(['profile/token', 'gmail/someone_else']),
      openBlobs: async () => fakeBlobs([]),
    });

    expect(ids(plan, 'secret')).toContain('profile/token');
    expect(ids(plan, 'secret')).not.toContain('gmail/someone_else');
    expect(plan.untouched.flatMap((u) => u.refs)).toContain('gmail/someone_else');
  });

  test('--target restricts to it, and leaves the profile itself alone', async () => {
    const two = config({
      targets: { local: target(), cloud: target() },
    } as never);

    const plan = await removalPlan(two, '/ws', 'personal', registry, {
      target: 'cloud',
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['a']),
    });

    expect(plan.items.every((item) => item.target === 'cloud')).toBe(true);
    expect(ids(plan, 'config')).toHaveLength(0);
    expect(ids(plan, 'workspace-key')).toHaveLength(0);
  });

  test('a deployed target warns that its endpoint keeps answering with nothing behind it', async () => {
    const deployed = config({
      targets: {
        cloud: target({ deploy: { platform: 'cloudrun', project: 'my-project' } } as never),
      },
    } as never);

    const plan = await removalPlan(deployed, '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets([]),
      openBlobs: async () => fakeBlobs([]),
    });

    expect(plan.warnings.join(' ')).toMatch(/keep answering|still answer/i);
  });

  test('a store that cannot be opened warns, and the other target still plans', async () => {
    const two = config({
      targets: { local: target(), cloud: target() },
    } as never);

    const plan = await removalPlan(two, '/ws', 'personal', registry, {
      openSecrets: async (name) => {
        if (name === 'cloud') throw new Error('no credentials for this project');
        return fakeSecrets(['profile/token']);
      },
      openBlobs: async () => fakeBlobs(['a']),
    });

    expect(plan.warnings.join(' ')).toMatch(/cloud/);
    expect(plan.items.some((item) => item.target === 'local')).toBe(true);
  });

  test('skills and manifests go with the profile that owns them — ADR-030', async () => {
    // They used to be workspace-wide, and this test used to assert the
    // opposite: that removal never touched them, because every profile saw
    // them. Now they are inside the profile's own blob root, so the sweep has
    // them for the same reason it has state and the log.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets([]),
      openBlobs: async () =>
        fakeBlobs([
          'state.kv/a',
          'audit.log/b',
          'skills.d/review-diff/SKILL.md',
          'providers.d/acme.yaml',
        ]),
    });

    const blobs = plan.items.filter((item) => item.kind === 'blob').map((item) => item.id);
    expect(blobs).toContain('skills.d/review-diff/SKILL.md');
    expect(blobs).toContain('providers.d/acme.yaml');
  });

  test('a declared storage path does not leave the authored areas behind', async () => {
    // `layout.skills` and `layout.providers` are explicit areas, like state and
    // the log — so a profile that points `storage.path` elsewhere moves its
    // provider blobs and nothing else. The sweep walks the declared root, so
    // without these two items the skills and manifests would survive a removal
    // that reported success.
    const moved = config({
      targets: { local: target({ storage: { adapter: 'filesystem', path: './elsewhere' } }) },
    } as Partial<Config>);

    const plan = await removalPlan(moved, '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets([]),
      openBlobs: async () => fakeBlobs([]),
    });

    const files = plan.items.filter((item) => item.kind === 'file').map((item) => item.id);
    expect(files).toContain('./elsewhere');
    expect(files).toContain('data/personal/skills.d');
    expect(files).toContain('data/personal/providers.d');
  });

  test('the ordinary layout names them once, not twice', async () => {
    // Inside the blob root, the sweep already has them. A second `file` item
    // for the same bytes would read as two things to delete in the preview the
    // operator confirms.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets([]),
      openBlobs: async () => fakeBlobs(['skills.d/review-diff/SKILL.md']),
    });

    const files = plan.items.filter((item) => item.kind === 'file').map((item) => item.id);
    expect(files).toEqual(['data/personal']);
  });

  test('"./data/personal" is the same directory as "data/personal"', async () => {
    // What `newProfileTemplate` actually writes, against what `layout` returns.
    // Compared as strings these differ, and every default profile would have
    // its skills and manifests named twice in the preview.
    const declared = config({
      targets: { local: target({ storage: { adapter: 'filesystem', path: './data/personal' } }) },
    } as Partial<Config>);

    const plan = await removalPlan(declared, '/ws', 'personal', registry, {
      openSecrets: async () => fakeSecrets([]),
      openBlobs: async () => fakeBlobs([]),
    });

    const files = plan.items.filter((item) => item.kind === 'file').map((item) => item.id);
    expect(files).toEqual(['./data/personal']);
  });
});

// --- renderPlan ------------------------------------------------------------

function captured(body: () => void): string {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string) => ((out += chunk), true);
  try {
    body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = write;
  }
  return out;
}

const samplePlan = (over: Partial<RemovalPlan> = {}): RemovalPlan => ({
  profile: 'personal',
  items: [
    { target: 'local', kind: 'secret', id: 'gmail/someone' },
    { target: 'local', kind: 'blob', id: 'state.kv/a' },
    { target: null, kind: 'config', id: '/ws/profiles/personal.yaml' },
  ],
  untouched: [],
  warnings: [],
  ...over,
});

describe('renderPlan', () => {
  test('names the profile and groups what goes by target', () => {
    const out = captured(() => renderPlan(samplePlan()));

    expect(out).toContain('personal');
    expect(out).toContain('local');
    expect(out).toContain('gmail/someone');
  });

  test('says untouched refs are left alone, so they do not read as pending', () => {
    const out = captured(() =>
      renderPlan(samplePlan({ untouched: [{ target: 'cloud', refs: ['gmail/other'] }] })),
    );

    expect(out).toContain('gmail/other');
    expect(out).toMatch(/left alone|not removed|leaves them/i);
  });

  test('prints every warning', () => {
    const out = captured(() =>
      renderPlan(samplePlan({ warnings: ['Target "cloud" is deployed.', 'Another thing.'] })),
    );

    expect(out).toContain('cloud');
    expect(out).toContain('Another thing.');
  });

  test('an empty plan says so rather than printing a blank preview', () => {
    const out = captured(() => renderPlan(samplePlan({ items: [] })));

    expect(out).toMatch(/nothing/i);
  });
});
