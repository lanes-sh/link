import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatableRefs } from './prepare.ts';
import { isWorkspaceConfig, repairSetupSurface } from './upload.ts';

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
    expect(isWorkspaceConfig('providers/acme.yaml')).toBe(true);
    expect(isWorkspaceConfig('skills/review-diff/SKILL.md')).toBe(true);
  });

  test('credentials never go, however they are spelled', () => {
    for (const key of [
      'data/personal/credentials.enc',
      'data/personal/credentials.enc.key',
      'data/personal/vault.enc',
      'data/personal/state.kv/connections%2Ev1/gmail%2Emain.json',
      'data/personal/audit.log/2026/08/12/x.json',
    ]) {
      expect(isWorkspaceConfig(key)).toBe(false);
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
    expect(isWorkspaceConfig('profiles/personal.yaml', 'personal')).toBe(true);
    expect(isWorkspaceConfig('profiles/work.yaml', 'personal')).toBe(false);
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

    await repairSetupSurface(root, undefined);

    // `work` is going to the bucket too, so it is going to be served. Repairing
    // a narrower set than the upload sends would leave it served and dark,
    // which is this bug one profile over.
    expect(await has(root, 'personal')).toBe(true);
    expect(await has(root, 'work')).toBe(true);
  });

  test('only the named one, matching what the upload sends', async () => {
    const root = await workspace('personal', 'work');

    await repairSetupSurface(root, 'personal');

    expect(await has(root, 'personal')).toBe(true);
    // Not touched: it is not going up, so editing it would be this command
    // changing config it was not asked about.
    expect(await has(root, 'work')).toBe(false);
  });

  test('a profile that already has it is left byte-identical', async () => {
    const root = await workspace('personal');
    await repairSetupSurface(root, undefined);
    const after = await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8');

    await repairSetupSurface(root, undefined);

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

      await repairSetupSurface(root, undefined);

      expect(await has(root, 'personal')).toBe(true);
      expect(await readFile(join(root, 'profiles', 'personal.example.yaml'), 'utf8')).toBe(
        'contract: 1\n',
      );
    });

    test('a nested directory under profiles/ is not a profile', async () => {
      const root = await workspace('personal');
      await write(root, 'archive/old.yaml', OLD('old'));

      await repairSetupSurface(root, undefined);

      expect(await has(root, 'personal')).toBe(true);
      expect(await has(root, 'archive/old')).toBe(false);
    });

    test('a profile that cannot be read is warned about, not fatal', async () => {
      const root = await workspace('personal', 'work');
      await writeFile(join(root, 'profiles', 'work.yaml'), 'a: [1, 2\n');

      // The upload that follows still sends it, which is what happened before
      // this function existed — repairing is a courtesy on the way past, and a
      // sibling nobody named should not cost the operator their rollout.
      await repairSetupSurface(root, undefined);

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
    // The same scoping `repairSetupSurface` has, and for a sharper reason: a
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
    expect(await rotatableRefs(root, 'personal')).toEqual(['gmail/mine']);
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
