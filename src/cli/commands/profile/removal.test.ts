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
    contract: 3,
    instance: { profile: 'personal' },
    auth: { mode: 'bearer', token_ref: 'profile/token' },
    grants: [{ connection: 'gmail.someone', allow: [], deny: [] }],
    members: [],
    ...over,
  }) as unknown as Config;

describe('declaredRefs', () => {
  test("covers the profile's own token, and nothing an account owns", () => {
    const refs = declaredRefs(config(), target());

    expect(refs).toContain('profile/token');

    // **Not the connection, and not the OAuth client.** Both belong to the
    // workspace now (ADR-057), and every one of them may be granted by a profile
    // that is staying — so removing a profile removes no account and no
    // credential. `lanes link disconnect` is the command that does that, and it
    // is the one that knows how to check whether anybody else still needs it.
    expect(refs).not.toContain('gmail/someone');
    expect(refs).not.toContain('google/client_id');
  });

  test('an oidc audience ref travels with the profile, because it is the profile\'s', () => {
    const refs = declaredRefs(
      config({
        auth: {
          mode: 'bearer',
          token_ref: 'profile/token',
          authorization: {
            mode: 'oidc',
            issuer: 'https://issuer.example',
            client_id_ref: 'oidc/audience',
            allowed_subjects: ['someone'],
          },
        },
      } as never),
      target(),
    );

    expect(refs).toContain('oidc/audience');
  });

  test('the vault ref comes from the target, because that is where it is declared', () => {
    // `vaultTargetSchema` sits inside `targetSchema`. Two targets may seal the
    // same profile's items in different places, so reading this off the profile
    // would attach one target's vault to another's removal.
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), sealed)).toContain('vault/document');
    expect(declaredRefs(config(), target())).not.toContain('vault/document');
  });

  test('a secret adapter with no ref names the vault connection, not a constant', () => {
    // This asserted `vault/document`, the contract-2 constant, and so pinned the
    // defect rather than the behaviour: `openVault` seals under
    // `vault/<connection>` (ADR-059), so removal queued a ref nothing had
    // written and left the real sealed document behind. Under-deletion, because
    // the survivor set was wrong the same way — but what survived is credential
    // material belonging to a profile the operator asked to be gone.
    const sealed = target({ vault: { adapter: 'secret' } } as never);

    expect(declaredRefs(config(), sealed)).toContain('vault/main');
    expect(declaredRefs(config(), sealed)).not.toContain('vault/document');
  });

  test('a connection whose provider no longer resolves contributes nothing', () => {
    // Its secret is reported as untouched rather than guessed at. A guessed
    // `<provider>/<id>` in a shared namespace could name someone else's.
    const gone = config({
      connections: [{ id: 'x', provider: 'no_such_provider', account: 'x' }],
    } as never);

    const refs = declaredRefs(gone, target());

    expect(refs).not.toContain('no_such_provider/x');
    expect(refs).toContain('profile/token');
  });

  test('the vault key is still the profile\'s to lose, and the connections are not', () => {
    // The asymmetry is the whole of ADR-057 at this seam. A vault document is
    // sealed per target and named by the target, so it goes with the removal;
    // a connection's credential belongs to an account that outlives the
    // profile, so it does not — whatever else the profile happened to say.
    const withConnections = config({
      grants: [
        { connection: 'gmail.a', allow: [], deny: [] },
        { connection: 'drive.b', allow: [], deny: [] },
      ],
    } as never);

    const refs = declaredRefs(
      withConnections,
      target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never),
    );

    expect(refs).toEqual(['profile/token', 'vault/document']);
  });

  test('a ref a surviving profile also declares is left alone', () => {
    // The credential store is one file per workspace since contract 3, and
    // every profile takes the template default `token_ref: profile/token`. So
    // removing one profile deleted the endpoint token the others are served by,
    // and the deployed revision then refused every request with "No profile
    // token in this target's credential store". The vault ref is read off the
    // target and is identical for every profile there, which made the sibling's
    // sealed items unrecoverable in the same command.
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), sealed, [config()])).toEqual([]);
  });

  test('with nobody staying, it is still the profile\'s to lose', () => {
    // The last profile in a workspace: there is no survivor to share with, so
    // the token and the vault go with it.
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), sealed, [])).toEqual(['profile/token', 'vault/document']);
  });

  test('a survivor with a different token ref does not protect this one', () => {
    // Sharing is the reason to keep a ref, not the mere existence of a sibling.
    const other = config({ auth: { mode: 'bearer', token_ref: 'other/token' } } as never);

    expect(declaredRefs(config(), target(), [other])).toContain('profile/token');
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
  test('plans the one target it was given, and the workspace items exactly once', async () => {
    // It used to loop over every target the profile declared. A profile lives in
    // exactly one (ADR-052), so the caller resolves that one and hands its
    // adapters in — there is no set here to iterate.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['state.kv/a']),
    });

    expect(plan.items.filter((i) => i.target === 'local')).not.toHaveLength(0);
    // `null` is the workspace itself — the profile config and `default_profile`,
    // which belong to no target.
    expect(plan.items.every((i) => i.target === 'local' || i.target === null)).toBe(true);
    expect(ids(plan, 'config').filter((id) => !id.startsWith('profiles/'))).toHaveLength(1);
  });


  test('plans no blob deletion at all, because a profile owns no bytes', async () => {
    // The property that replaced six tests about a sweep. Under contract 2 the
    // blob root *was* the profile's directory and `rm -r data/work` was the
    // whole answer to "what could this profile reach". The root is the
    // workspace's now (ADR-057, ADR-059), and the stores under it belong to
    // connections other profiles may grant — so listing it here would queue
    // every byte in the workspace for deletion because one profile is going.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['memory/main/note.md', 'skills.d/main/triage.md']),
    });

    expect(plan.items.filter((item) => item.kind === 'blob')).toEqual([]);
    expect(plan.items.filter((item) => item.kind === 'file')).toEqual([]);
    // The profile's own token still goes, and the profile file still goes.
    expect(ids(plan, 'secret')).toContain('profile/token');
    expect(plan.items.some((item) => item.kind === 'config')).toBe(true);
  });

  test('the local config is the last item, because it is the record of where things are', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['a']),
    });

    expect(plan.items.at(-1)?.kind).toBe('config');
  });

  test('a ref the profile does not declare is reported, never planned', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      openSecrets: async () => fakeSecrets(['profile/token', 'gmail/someone_else']),
      openBlobs: async () => fakeBlobs([]),
    });

    expect(ids(plan, 'secret')).toContain('profile/token');
    expect(ids(plan, 'secret')).not.toContain('gmail/someone_else');
    expect(plan.untouched.flatMap((u) => u.refs)).toContain('gmail/someone_else');
  });

  test('the profile config goes too, because it lives in that target', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'cloud',
      declared: target(),
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['a']),
    });

    // `--target` used to mean "empty this one and keep the profile". There is
    // nowhere left for it to be kept: the file is in that workspace (ADR-052).
    expect(plan.items.filter((item) => item.target !== null).every((i) => i.target === 'cloud')).toBe(true);
    expect(ids(plan, 'config')).toHaveLength(1);
  });

  test('a deployed target warns that its endpoint keeps answering with nothing behind it', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'cloud',
      declared: target({
        deploy: { platform: 'cloudrun', project: 'my-project', region: 'r', service: 's' },
      } as never),
      openSecrets: async () => fakeSecrets([]),
      openBlobs: async () => fakeBlobs([]),
    });

    expect(plan.warnings.join(' ')).toMatch(/keep answering|still answer/i);
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
