import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatableRefs } from './prepare.ts';
import { unservableProfiles, unservableRefusal } from './servable.ts';
import {
  deployedWorkspace,
  isWorkspaceConfig,
  publishWorkspace,
  uploadWorkspace,
} from './upload.ts';
import { repairOwnerLayer } from '#cli/config-repair.ts';
import { layout, parseConfig, workspaceFiles } from '#profile';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * What a deploy uploads, and — the half that matters — what it does not.
 *
 * `data/` holds the encrypted credential store and the key file that opens it.
 * The deployed target reads credentials from Secret Manager, so sending that
 * directory would put a decryptable credential document in a bucket for no
 * reason at all. `.dockerignore` guards the same boundary for the image and
 * calls itself load-bearing; this is the same boundary for the upload.
 */
describe('what a deploy sends up', () => {
  test('config goes', () => {
    expect(isWorkspaceConfig('lanes-link.yaml')).toBe(true);
    expect(isWorkspaceConfig('profiles/personal.yaml')).toBe(true);
  });

  test('the authored areas inside a profile go — they are config, not state', () => {
    // ADR-030 moved both into the profile. They still have to go up: a skill
    // that does not is the ADR-014 §2 regression, and a manifest that does not
    // is a provider the revision has never heard of.
    expect(isWorkspaceConfig('data/personal/skills.d/review-diff/SKILL.md')).toBe(true);
    expect(isWorkspaceConfig('data/personal/skills.d/review-diff.md')).toBe(true);
    expect(isWorkspaceConfig('data/personal/providers.d/acme.yaml')).toBe(true);
  });

  test('the old workspace-wide paths do not go — nothing reads them now', () => {
    expect(isWorkspaceConfig('providers/acme.yaml')).toBe(false);
    expect(isWorkspaceConfig('skills/review-diff/SKILL.md')).toBe(false);
  });

  test('credentials never go, however they are spelled', () => {
    for (const key of [
      'data/personal/credentials.enc',
      'data/personal/credentials.enc.key',
      'data/personal/vault.enc',
      'data/personal/vault.enc.key',
      'data/personal/state.kv/connections%2Ev1/gmail%2Emain.json',
      'data/personal/audit.log/2026/08/12/x.json',
      'data/personal/memory/main/note.md',
      'data/personal/gmail/ada_lovelace/attachments/x.pdf',
    ]) {
      expect(isWorkspaceConfig(key)).toBe(false);
    }
  });

  test('reaching into data/ matches whole segments, never prefixes', () => {
    // The allowlist now names two directories inside the tree it otherwise
    // refuses wholesale. A prefix match would send anything merely starting
    // with the same letters, and the thing on the other side of that boundary
    // is the credential store.
    for (const key of [
      'data/personal/skills.detour/leak.md',
      'data/personal/providers.disabled/acme.yaml',
      'data/personal/skills.d',
      'data/personal/providers.d',
      'data/skills.d/review-diff.md',
      'data//skills.d/review-diff.md',
    ]) {
      expect({ key, sent: isWorkspaceConfig(key) }).toEqual({ key, sent: false });
    }
  });

  test('nothing outside the known config paths goes', () => {
    // An allowlist, so a file nobody thought about is excluded rather than
    // included. A forgotten config file is a loud failure; an included
    // credential is a silent one.
    for (const key of ['README.md', 'node_modules/x/package.json', '.env', 'notes.txt']) {
      expect(isWorkspaceConfig(key)).toBe(false);
    }
  });

  test('naming a profile sends only that one', () => {
    // A workspace holding personal and work should not push both into a bucket
    // that only one of them is for.
    expect(isWorkspaceConfig('profiles/personal.yaml', ['personal'])).toBe(true);
    expect(isWorkspaceConfig('profiles/work.yaml', ['personal'])).toBe(false);

    // Same question for the authored areas, which are now the larger half of
    // what goes up.
    expect(isWorkspaceConfig('data/personal/skills.d/a.md', ['personal'])).toBe(true);
    expect(isWorkspaceConfig('data/work/skills.d/a.md', ['personal'])).toBe(false);
    expect(isWorkspaceConfig('data/work/providers.d/acme.yaml', ['personal'])).toBe(false);
  });
});

/**
 * A profile written before the setup surface existed serves no `setup_overview`,
 * and nothing at runtime says why — so an agent asked what is connected has
 * nothing to read and invents a command. `doctor` reports it; the operator of a
 * deployed endpoint has no reason to run `doctor`.
 *
 * The property that matters is that the repair covers exactly what the upload
 * covers. Repairing only the resolved profile while sending the whole workspace
 * up would leave the others broken and look like it had not.
 */
describe('what a deploy repairs before sending it', () => {
  /** An old profile: a real connection, its grant, and no setup surface. */
  const OLD = (name: string) => `contract: 1
instance:
  profile: ${name}
  default_target: local
  port: 7337
targets:
  local:
    credentials: { adapter: file, path: ./data/${name}.credentials.enc }
    storage: { adapter: filesystem, path: ./data/${name}/files }
connections:
  - { id: a, provider: example, account: someone@example.test }
policy:
  allow: [example.*]
  deny: []
`;

  async function workspace(...profiles: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-deploy-'));
    roots.push(root);
    await mkdir(join(root, 'profiles'), { recursive: true });
    for (const name of profiles) {
      await writeFile(join(root, 'profiles', `${name}.yaml`), OLD(name));
    }
    return root;
  }

  const has = async (root: string, name: string): Promise<boolean> =>
    (await readFile(join(root, 'profiles', `${name}.yaml`), 'utf8')).includes('provider: setup');

  test('every profile it would upload, when none is named', async () => {
    const root = await workspace('personal', 'work');

    await repairOwnerLayer(root, undefined);

    // `work` is going to the bucket too, so it is going to be served. Repairing
    // a narrower set than the upload sends would leave it served and dark,
    // which is this bug one profile over.
    expect(await has(root, 'personal')).toBe(true);
    expect(await has(root, 'work')).toBe(true);
  });

  test('only the named one, matching what the upload sends', async () => {
    const root = await workspace('personal', 'work');

    await repairOwnerLayer(root, ['personal']);

    expect(await has(root, 'personal')).toBe(true);
    // Not touched: it is not going up, so editing it would be this command
    // changing config it was not asked about.
    expect(await has(root, 'work')).toBe(false);
  });

  test('reports where it is told to, so a --json caller keeps its stdout', async () => {
    // `lanes link update` repairs on the way past and can be asked for a
    // document. The repair still says what it widened — a policy edit nobody
    // asked for is not a thing to do quietly — it just says it somewhere that
    // does not corrupt the answer.
    const root = await workspace('personal');
    const lines: string[] = [];

    await repairOwnerLayer(root, undefined, { report: (line) => lines.push(line) });

    expect(await has(root, 'personal')).toBe(true);
    expect(lines.join('\n')).toContain('owner layer');
  });

  test('a profile that already has it is left byte-identical', async () => {
    const root = await workspace('personal');
    await repairOwnerLayer(root, undefined);
    const after = await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8');

    await repairOwnerLayer(root, undefined);

    expect(await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8')).toBe(after);
  });

  /**
   * What the upload may *copy* and what this may *edit* are different questions,
   * and only one of them is destructive.
   *
   * `isWorkspaceConfig` is an allowlist for sending bytes, so it is happy to
   * include a committed template and a nested directory. This function opens,
   * mutates and validates what it is handed, so scoping it by that allowlist
   * made every one of those a way to abort a deploy — several steps after the
   * provision that had already created cloud resources. `listProfiles` is what
   * knows which files are profiles, and has excluded both since before this
   * existed.
   */
  describe('what it will not treat as a profile', () => {
    const write = async (root: string, key: string, text: string): Promise<void> => {
      await mkdir(join(root, 'profiles', key, '..'), { recursive: true });
      await writeFile(join(root, 'profiles', key), text);
    };

    test('a committed *.example.yaml neither aborts the deploy nor gets edited', async () => {
      const root = await workspace('personal');
      // Sorts before `personal.yaml`, so opening it first meant nothing was
      // repaired at all before the throw.
      await write(root, 'personal.example.yaml', 'contract: 1\n');

      await repairOwnerLayer(root, undefined);

      expect(await has(root, 'personal')).toBe(true);
      expect(await readFile(join(root, 'profiles', 'personal.example.yaml'), 'utf8')).toBe(
        'contract: 1\n',
      );
    });

    test('a nested directory under profiles/ is not a profile', async () => {
      const root = await workspace('personal');
      await write(root, 'archive/old.yaml', OLD('old'));

      await repairOwnerLayer(root, undefined);

      expect(await has(root, 'personal')).toBe(true);
      expect(await has(root, 'archive/old')).toBe(false);
    });

    test('a profile that cannot be read is warned about, not fatal', async () => {
      const root = await workspace('personal', 'work');
      await writeFile(join(root, 'profiles', 'work.yaml'), 'a: [1, 2\n');

      // The upload that follows still sends it, which is what happened before
      // this function existed — repairing is a courtesy on the way past, and a
      // sibling nobody named should not cost the operator their rollout.
      await repairOwnerLayer(root, undefined);

      expect(await has(root, 'personal')).toBe(true);
    });
  });
});

/**
 * Which credentials the deploy hands `provision` to bind, from a real profile
 * and real manifests.
 *
 * `grants.test.ts` pins the other end — that a ref handed in gets created and
 * bound, and that the refs handed in are the ones the refresh path writes. This
 * pins the derivation that produces them, because the two ends met through a
 * chain that did not exist at all until the endpoint started 403ing: config →
 * manifest → the ref `CredentialOAuthProvider` rewrites while serving.
 */
describe('which credentials a deploy asks provision to bind', () => {
  const PROFILE = (name: string, connections: string) => `contract: 1
instance:
  profile: ${name}
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/${name}.credentials.enc }
    storage: { adapter: filesystem, path: ./data/${name}/files }
connections:
${connections}
policy:
  allow: ['*']
  deny: []
`;

  async function workspaceOf(profiles: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-rotatable-'));
    roots.push(root);
    await mkdir(join(root, 'profiles'), { recursive: true });
    for (const [name, connections] of Object.entries(profiles)) {
      await writeFile(join(root, 'profiles', `${name}.yaml`), PROFILE(name, connections));
    }
    return root;
  }

  test('an OAuth connection contributes the ref its refresh writes', async () => {
    const root = await workspaceOf({
      personal:
        '  - { id: ada_lovelace, provider: gmail, account: a@example.test }\n' +
        '  - { id: rin_shaw, provider: gmail, account: b@example.test }',
    });

    // Per connection, never per provider: two mailboxes hold two refresh
    // tokens, and binding one would leave the other failing exactly as before.
    // Sorted, which is what makes the list stable across runs.
    expect(await rotatableRefs(root, undefined)).toEqual([
      'gmail/ada_lovelace',
      'gmail/rin_shaw',
    ]);
  });

  test('a provider that authenticates with nothing contributes nothing', async () => {
    const root = await workspaceOf({ personal: '  - { id: main, provider: example, account: local }' });

    // A grant on a secret nobody writes is a grant that says the boundary is
    // wider than it is.
    expect(await rotatableRefs(root, undefined)).toEqual([]);
  });

  test('every profile the upload sends, when none is named', async () => {
    // The same scoping `repairOwnerLayer` has, and for a sharper reason: a
    // deploy with no `--profile` sends the whole workspace up, so binding only
    // the resolved profile leaves the others served and 403ing an hour later.
    const root = await workspaceOf({
      personal: '  - { id: mine, provider: gmail, account: a@example.test }',
      work: '  - { id: theirs, provider: gmail, account: b@example.test }',
    });

    expect(await rotatableRefs(root, undefined)).toEqual(['gmail/mine', 'gmail/theirs']);
  });

  test('only the named one, matching what the upload sends', async () => {
    const root = await workspaceOf({
      personal: '  - { id: mine, provider: gmail, account: a@example.test }',
      work: '  - { id: theirs, provider: gmail, account: b@example.test }',
    });

    // Not going up, so not served, so granting for it would widen the boundary
    // over a profile this run was told to leave alone.
    expect(await rotatableRefs(root, ['personal'])).toEqual(['gmail/mine']);
  });

  test('a profile that cannot be read is skipped, not fatal', async () => {
    const root = await workspaceOf({
      personal: '  - { id: mine, provider: gmail, account: a@example.test }',
    });
    await writeFile(join(root, 'profiles', 'work.yaml'), 'a: [1, 2\n');

    // Matching the repair: a broken sibling nobody named should not cost the
    // operator a rollout, and provisioning happens before anything is uploaded.
    expect(await rotatableRefs(root, undefined)).toEqual(['gmail/mine']);
  });
});

/**
 * Where a config edit goes, once it is no longer a deploy that takes it there.
 *
 * `publishWorkspace` answers "where does the endpoint for this target read its
 * config" and nothing else. The interesting half is the `null`: a local target
 * reads the same files the CLI just wrote, so publishing to it would be copying
 * a file over itself.
 */
describe('publishing a config edit', () => {
  const targets = (extra: string): string => `
contract: 1
instance:
  profile: personal
  default_target: local
  port: 7337
targets:
  local:
    credentials: { adapter: file, path: ./data/personal/credentials.enc }
    storage: { adapter: filesystem, path: ./data/personal }
${extra}
connections: []
policy:
  allow: []
`;

  test('a filesystem target publishes nowhere', async () => {
    const { config } = parseConfig(targets(''));

    expect(await publishWorkspace({ config, workspaceRoot: '/nowhere', target: 'local', profile: 'personal' })).toBeNull();
  });

  test('an undeclared target publishes nowhere rather than throwing', async () => {
    const { config } = parseConfig(targets(''));

    // The edit already succeeded and is on disk. A target nobody declared is a
    // problem for `check` to report, not a reason to fail the edit that is done.
    expect(await publishWorkspace({ config, workspaceRoot: '/nowhere', target: 'cloud', profile: 'personal' })).toBeNull();
  });

  test('a bucket-backed target resolves to the bucket it declares', () => {
    const { config } = parseConfig(
      targets(`  cloud:
    credentials: { adapter: file, path: ./data/personal/credentials.enc }
    storage: { adapter: gcs, bucket: your-bucket, prefix: workspace }`),
    );

    // The destination is derived from the target, never passed in — which is
    // the whole of what `publishWorkspace` adds over `uploadWorkspace`. Driving
    // the copy itself would need a bucket; the allowlist that governs it is
    // covered above.
    expect(deployedWorkspace(config.targets['cloud']!)).toBe('gs://your-bucket/workspace');
    expect(deployedWorkspace(config.targets['local']!)).toBeUndefined();
  });
});

/**
 * The allowlist against a real listing, rather than against keys typed by hand.
 *
 * `uploadWorkspace` walks `list('')` over the whole workspace, which descends
 * into `data/` and returns `credentials.enc` along with everything else — the
 * filter is the only thing between that listing and a bucket. Testing the
 * predicate alone leaves the pairing untested, and the pairing is where a
 * credential would leak: a listing that stopped recursing would make the
 * skills half silently do nothing, and one that recursed further than the
 * filter expects would send the rest.
 *
 * Driven between two directories because a `BlobStore` over a local path and
 * one over a bucket are the same interface. No bucket required.
 */
describe('the allowlist against a real workspace listing', () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function populated(): Promise<{ source: string; destination: string }> {
    const source = await mkdtemp(join(tmpdir(), 'lanes-link-upload-'));
    const destination = await mkdtemp(join(tmpdir(), 'lanes-link-bucket-'));
    roots.push(source, destination);

    const files: Record<string, string> = {
      'lanes-link.yaml': 'contract: 1\ndefault_profile: personal\n',
      'profiles/personal.yaml': 'contract: 1\n',
      'profiles/work.yaml': 'contract: 1\n',
      [`${layout.skills('personal')}/review-diff/SKILL.md`]: '---\ndescription: d\n---\nb\n',
      [`${layout.providers('personal')}/acme.yaml`]: 'id: acme\n',
      [`${layout.skills('work')}/triage.md`]: '---\ndescription: d\n---\nb\n',
      'data/personal/credentials.enc': 'ciphertext',
      'data/personal/credentials.enc.key': 'the key that opens it',
      'data/personal/vault.enc': 'ciphertext',
      'data/personal/state.kv/connections%2Ev1/example%2Ea.json': '{}',
      'data/personal/audit.log/2026/08/24/x.json': '{}',
      'data/personal/memory/main/note.md': 'a note',
      'data/personal/example/a/attachments/x.pdf': 'bytes',
    };

    for (const [key, contents] of Object.entries(files)) {
      await mkdir(join(source, key, '..'), { recursive: true });
      await writeFile(join(source, key), contents);
    }

    return { source, destination };
  }

  const landed = async (root: string): Promise<string[]> =>
    (await workspaceFiles(root).list('')).map((entry) => entry.key).sort();

  test('the whole workspace goes, and nothing else in data/ does', async () => {
    const { source, destination } = await populated();

    await uploadWorkspace(source, destination, undefined);

    expect(await landed(destination)).toEqual([
      'data/personal/providers.d/acme.yaml',
      'data/personal/skills.d/review-diff/SKILL.md',
      'data/work/skills.d/triage.md',
      'lanes-link.yaml',
      'profiles/personal.yaml',
      'profiles/work.yaml',
    ]);
  });

  test('naming a profile sends that profile and the workspace file', async () => {
    const { source, destination } = await populated();

    await uploadWorkspace(source, destination, ['personal']);

    expect(await landed(destination)).toEqual([
      'data/personal/providers.d/acme.yaml',
      'data/personal/skills.d/review-diff/SKILL.md',
      'lanes-link.yaml',
      'profiles/personal.yaml',
    ]);
  });

  test('the source really does offer the credential store to the filter', async () => {
    // Without this, the test above passes just as well against a listing that
    // never descends into `data/` — which would mean the skills never go up
    // either, silently.
    const { source } = await populated();

    expect(await landed(source)).toContain('data/personal/credentials.enc.key');
  });
});

/**
 * Whether every profile a deploy sends can run where it is sending them.
 *
 * The endpoint opens every profile in the bucket against the one target the
 * revision was baked with, so a profile that does not declare it is not skipped
 * — it throws on the way up and the revision never goes healthy. The symptom is
 * a deploy that reports success followed by a service that will not start, and
 * nothing in either points at the profile that caused it.
 */
describe('whether a profile can run where it is being sent', () => {
  const PROFILE = (name: string, targets: string) => `contract: 1
instance:
  profile: ${name}
  default_target: local
  port: 7337
targets:
${targets}
connections: []
policy:
  allow: []
  deny: []
`;

  const LOCAL = `  local:
    credentials: { adapter: file, path: ./data/x/credentials.enc }
    storage: { adapter: filesystem, path: ./data/x }`;

  const CLOUD = `  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    vault: { adapter: secret }`;

  async function workspaceOf(profiles: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-servable-'));
    roots.push(root);
    await mkdir(join(root, 'profiles'), { recursive: true });
    for (const [name, targets] of Object.entries(profiles)) {
      await writeFile(join(root, 'profiles', `${name}.yaml`), PROFILE(name, targets));
    }
    return root;
  }

  test('says nothing when every profile declares the target', async () => {
    const root = await workspaceOf({
      personal: `${LOCAL}\n${CLOUD}`,
      work: `${LOCAL}\n${CLOUD}`,
    });

    expect(await unservableProfiles({ workspaceRoot: root, profiles: undefined, target: 'cloud' })).toEqual([]);
  });

  test('names the profile that would take the revision down', async () => {
    const root = await workspaceOf({ personal: `${LOCAL}\n${CLOUD}`, work: LOCAL });

    const found = await unservableProfiles({ workspaceRoot: root, profiles: undefined, target: 'cloud' });

    expect(found).toEqual([{ profile: 'work', declares: ['local'] }]);
  });

  test('is scoped as the upload is, so --profile narrows it too', async () => {
    // The set that gets uploaded is the set that gets served. Checking a wider
    // one would refuse a deploy that was never going to send the bad profile.
    const root = await workspaceOf({ personal: `${LOCAL}\n${CLOUD}`, work: LOCAL });

    expect(await unservableProfiles({ workspaceRoot: root, profiles: ['personal'], target: 'cloud' })).toEqual([]);
    expect(
      (await unservableProfiles({ workspaceRoot: root, profiles: ['work'], target: 'cloud' })).map((one) => one.profile),
    ).toEqual(['work']);
  });

  test('leaves an unparseable profile to the error that reads better', async () => {
    // It is already fatal further along, and a YAML syntax error dressed up as
    // "cannot run on cloud" sends someone looking at their targets.
    const root = await workspaceOf({ personal: `${LOCAL}\n${CLOUD}` });
    await writeFile(join(root, 'profiles', 'broken.yaml'), 'targets: [unclosed\n');

    expect(await unservableProfiles({ workspaceRoot: root, profiles: undefined, target: 'cloud' })).toEqual([]);
  });

  test('the refusal names the target, what was declared, and both ways out', () => {
    const text = unservableRefusal([{ profile: 'work', declares: ['local'] }], 'cloud');

    expect(text).toContain('cannot run on "cloud"');
    expect(text).toContain('work   declares: local');
    expect(text).toContain('lanes link profile add <name> --target cloud');
    expect(text).toContain('--profile <name>');
  });
});
