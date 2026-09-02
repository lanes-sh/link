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
    contract: 5,
    instance: { profile: 'personal' },
    auth: { mode: 'bearer' },
    grants: [{ connection: 'gmail.someone', allow: [], deny: [] }],
    members: [],
    ...over,
  }) as unknown as Config;

describe('declaredRefs', () => {
  test('covers nothing an account owns, and no endpoint token', () => {
    const refs = declaredRefs(config(), target());

    // **Not the endpoint token.** It is the workspace's since ADR-068, so a
    // profile declares none and removing one cannot reach it. This is the fix
    // for the bug the survivor check existed to work around: removing a profile
    // used to delete the token its siblings were being served by.
    expect(refs).not.toContain('profile/token');
    expect(refs.some((ref) => ref.startsWith('tokens/'))).toBe(false);

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

  test('a secret adapter with no ref names the profile and connection, not a constant', () => {
    // This asserted `vault/document`, the contract-2 constant, and so pinned the
    // defect rather than the behaviour: `openVault` seals under
    // `vault/<connection>` (ADR-059), so removal queued a ref nothing had
    // written and left the real sealed document behind. Under-deletion, because
    // the survivor set was wrong the same way — but what survived is credential
    // material belonging to a profile the operator asked to be gone.
    const sealed = target({ vault: { adapter: 'secret' } } as never);

    expect(declaredRefs(config(), sealed)).toContain('vault/personal/main');
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

    expect(refs).toEqual(['vault/document']);
  });

  test('a ref a surviving profile also declares is left alone', () => {
    // The vault ref is read off the target and is identical for every profile
    // there, which once made a sibling's sealed items unrecoverable in this
    // command. The endpoint token used to be the other half of this test and is
    // no longer a case at all: it is not a profile's to declare (ADR-068).
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), sealed, [config()])).toEqual([]);
  });

  test('with nobody staying, the vault is still the profile\'s to lose', () => {
    // The last profile in a workspace: there is no survivor to share with, so
    // the vault goes with it. The endpoint token does not, and that is the
    // point — a workspace can outlive its last profile's removal with its
    // issued tokens intact, because they were never that profile's.
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), sealed, [])).toEqual(['vault/document']);
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
      disposition: { kind: 'delete' as const },
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['state.kv/a']),
    });

    expect(plan.items.filter((i) => i.target === 'local')).not.toHaveLength(0);
    // `null` is the workspace itself — the profile config and `default_profile`,
    // which belong to no target.
    expect(plan.items.every((i) => i.target === 'local' || i.target === null)).toBe(true);
    expect(ids(plan, 'config').filter((id) => !id.startsWith('profiles/'))).toHaveLength(1);
  });


  test("sweeps the profile's own directory, and nothing an account owns", async () => {
    // The inverse of what this file asserted under ADR-059, when a profile
    // owned no bytes and the blob root was the whole workspace — listing it
    // then would have queued every byte in the workspace for deletion because
    // one profile was going. The profile has a directory again (ADR-066), so
    // the sweep is bounded by it.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      disposition: { kind: 'delete' as const },
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['memory/lan1/note.md', 'skills.d/lan4/triage.md']),
    });

    // Keys within the profile's own area, which is carried on the item — the
    // executor opens the store at that area, and the two must not be able to
    // disagree about where a key is rooted.
    expect(ids(plan, 'blob')).toEqual(['memory/lan1/note.md', 'skills.d/lan4/triage.md']);
    expect(plan.items.filter((item) => item.kind === 'blob').map((item) => item.area)).toEqual([
      'profiles/personal',
      'profiles/personal',
    ]);
    // An adapter must never delete the root it was configured with, so emptying
    // leaves the directory — and one left behind is silently reused by a later
    // `profile add` of the same name.
    expect(ids(plan, 'file')).toEqual(['profiles/personal']);

    // Nothing. A profile with a plain target declares no credential of its own
    // since ADR-068 — the endpoint token is the workspace's, and a connection's
    // belongs to the account. The vault is the one that can still be here, and
    // this target seals nothing.
    expect(ids(plan, 'secret')).toEqual([]);
    expect(plan.items.some((item) => item.kind === 'config')).toBe(true);
  });

  test('--migrate-to sends every object into the other profile rather than deleting it', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      disposition: { kind: 'migrate' as const, into: 'work' },
      openSecrets: async () => fakeSecrets(['profile/token']),
      // `work` holds nothing, so there is nothing to collide with.
      openBlobs: async (_target, area) =>
        area === 'profiles/work' ? fakeBlobs([]) : fakeBlobs(['memory/lan1/note.md']),
    });

    // Still a deletion of the source — what changes is that the bytes are read
    // across first, so a failure part way through leaves the source in place.
    expect(plan.items.filter((item) => item.kind === 'blob')).toEqual([
      {
        target: 'local',
        kind: 'blob',
        id: 'memory/lan1/note.md',
        area: 'profiles/personal',
        movedTo: ['profiles/work', 'memory/lan1/note.md'],
      },
    ]);
  });

  test('cursors and a sealed vault do not cross into another profile', async () => {
    // The prompt asks about memory, tasks, assets and skills. The directory
    // holds two more things: a cursor would hand the destination another
    // profile's read position, and a sealed vault cannot merge — both profiles
    // hold `vault.d/lan5.enc` since the owner layer merged, so a copy always
    // collided and had its source deleted, leaving the items unreachable.
    await expect(
      removalPlan(config(), '/ws', 'personal', registry, {
        target: 'local',
        declared: target(),
        disposition: { kind: 'migrate' as const, into: 'work' },
        openSecrets: async () => fakeSecrets(['profile/token']),
        openBlobs: async (_t, area) =>
          area === 'profiles/work' ? fakeBlobs([]) : fakeBlobs(['vault.d/lan5.enc']),
      }),
    ).rejects.toThrow(/vault cannot be merged[\s\S]*--delete-data/);

    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      disposition: { kind: 'migrate' as const, into: 'work' },
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async (_t, area) =>
        area === 'profiles/work'
          ? fakeBlobs([])
          : fakeBlobs(['state.kv/cursors%2Ev1/gmail%2Econ1.json', 'lanes_memory/lan1/note.md']),
    });

    const migrated = plan.items.filter((item) => item.kind === 'blob' && item.movedTo !== undefined);
    expect(migrated.map((item) => item.id)).toEqual(['lanes_memory/lan1/note.md']);
    // Still deleted with the profile — derived state is nobody's to inherit.
    expect(ids(plan, 'blob')).toContain('state.kv/cursors%2Ev1/gmail%2Econ1.json');
  });

  test('a name the destination already holds is renamed, never overwritten', async () => {
    // Resolved while this is still a plan, so the operator sees the rename in
    // the preview they confirm from and the execution has no decision to make.
    // The suffix goes before the extension: an asset's key is whatever the file
    // was called, and `note.md-2` is a file nothing will open.
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      disposition: { kind: 'migrate' as const, into: 'work' },
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async (_target, area) =>
        area === 'profiles/work'
          ? fakeBlobs(['memory/lan1/note.md'])
          : fakeBlobs(['memory/lan1/note.md']),
    });

    const blob = plan.items.find((item) => item.kind === 'blob');
    expect(blob?.movedTo).toEqual(['profiles/work', 'memory/lan1/note-2.md']);
    expect(plan.warnings.join('\n')).toContain('arrives as memory/lan1/note-2.md');
  });

  test('a skill the destination already has refuses, because a suffix resolves nothing', async () => {
    // A skill's name is not a filename: it becomes the capability id
    // `skills.<name>`, which policy rules grant and MCP prompts are called by.
    // So `proc-b-2` arrives granted by no rule the destination holds and
    // offered to no client — `refuseSealedVault`'s argument by another route.
    // Renaming only the directory is worse: the frontmatter keeps declaring the
    // old name, and `skills list` then refuses for the whole profile.
    await expect(
      removalPlan(config(), '/ws', 'personal', registry, {
        target: 'local',
        declared: target(),
        disposition: { kind: 'migrate' as const, into: 'work' },
        openSecrets: async () => fakeSecrets(['profile/token']),
        openBlobs: async (_t, area) =>
          area === 'profiles/work'
            ? fakeBlobs(['skills.d/lan3/proc-b/SKILL.md'])
            : fakeBlobs(['skills.d/lan3/proc-b/SKILL.md']),
      }),
    ).rejects.toThrow(/skill named "proc-b"[\s\S]*--delete-data/);
  });

  test('a skill only one of them has migrates, whole', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      disposition: { kind: 'migrate' as const, into: 'work' },
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async (_t, area) =>
        area === 'profiles/work'
          ? fakeBlobs(['skills.d/lan3/other/SKILL.md'])
          : fakeBlobs(['skills.d/lan3/proc-a/SKILL.md', 'skills.d/lan3/proc-a/helper.py']),
    });

    // Everything the skill ships, not just its SKILL.md — a bundle split across
    // two directories is a skill that loads without half of itself.
    expect(
      plan.items.filter((item) => item.kind === 'blob').map((item) => item.movedTo?.[1]),
    ).toEqual(['skills.d/lan3/proc-a/SKILL.md', 'skills.d/lan3/proc-a/helper.py']);
    expect(plan.warnings).toEqual([]);
  });

  test('the local config is the last item, because it is the record of where things are', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'local',
      declared: target(),
      disposition: { kind: 'delete' as const },
      openSecrets: async () => fakeSecrets(['profile/token']),
      openBlobs: async () => fakeBlobs(['a']),
    });

    expect(plan.items.at(-1)?.kind).toBe('config');
  });

  test('a ref the profile does not declare is reported, never planned', async () => {
    // The vault document, which is the profile's remaining declared credential:
    // sealed per target and named by it, so it goes with the removal. Contrasted
    // against an account's, which outlives the profile whatever the profile said.
    const plan = await removalPlan(
      config(),
      '/ws',
      'personal',
      registry,
      {
        target: 'local',
        declared: target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never),
        disposition: { kind: 'delete' as const },
        openSecrets: async () => fakeSecrets(['vault/document', 'gmail/someone_else']),
        openBlobs: async () => fakeBlobs([]),
      },
    );

    expect(ids(plan, 'secret')).toContain('vault/document');
    expect(ids(plan, 'secret')).not.toContain('gmail/someone_else');
    expect(plan.untouched.flatMap((u) => u.refs)).toContain('gmail/someone_else');
  });

  test('the profile config goes too, because it lives in that target', async () => {
    const plan = await removalPlan(config(), '/ws', 'personal', registry, {
      target: 'cloud',
      declared: target(),
      disposition: { kind: 'delete' as const },
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
      disposition: { kind: 'delete' as const },
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
    { target: null, kind: 'config', id: '/ws/profiles/personal/profile.yaml' },
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
