import { CONNECTIONS_FILE, type TargetConfig } from '#profile';
import { workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readableRefs, rotatableRefs } from './prepare.ts';
import { registerLine } from './report.ts';
import {
  deployedWorkspace,
  isWorkspaceConfig,
  publishWorkspace,
  uploadWorkspace,
} from './upload.ts';
import { repairOwnerLayer } from '#cli/config-repair-sweep.ts';
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
  test('profiles go, and the workspace file does not', () => {
    expect(isWorkspaceConfig('profiles/personal/profile.yaml')).toBe(true);

    // The one file that must not travel. It holds the target registry, and the
    // two workspaces have different ones: this machine's says
    // `cloud: workspace: gs://…`, so copying it into that bucket left the bucket
    // pointing at itself — a loop `openTarget` refuses, on the target that had
    // just been deployed (ADR-052). The bucket's own registry is written by
    // `deploy`, from the declaration, once the upload is done.
    expect(isWorkspaceConfig('workspaces.yaml')).toBe(false);
  });

  test('the authored areas inside a profile go — they are config, not state', () => {
    // ADR-030 moved both into the profile. They still have to go up: a skill
    // that does not is the ADR-014 §2 regression, and a manifest that does not
    // is a provider the revision has never heard of.
    expect(isWorkspaceConfig('profiles/personal/skills.d/main/review-diff/SKILL.md')).toBe(true);
    expect(isWorkspaceConfig('profiles/personal/skills.d/main/review-diff.md')).toBe(true);
    expect(isWorkspaceConfig('providers.d/acme.yaml')).toBe(true);
  });

  test('the old paths do not go — nothing reads them now', () => {
    expect(isWorkspaceConfig('providers/acme.yaml')).toBe(false);
    expect(isWorkspaceConfig('skills/review-diff/SKILL.md')).toBe(false);
    // The per-profile shape contract 3 replaced.
    expect(isWorkspaceConfig('data/personal/skills.d/review-diff.md')).toBe(false);
    expect(isWorkspaceConfig('data/personal/providers.d/acme.yaml')).toBe(false);
  });

  test('credentials never go, however they are spelled', () => {
    for (const key of [
      'credentials.enc',
      'credentials.enc.key',
      'profiles/personal/vault.d/main.enc',
      'profiles/personal/vault.d/main.enc.key',
      'state.kv/connections%2Ev1/gmail%2Emain.json',
      'audit.log/2026/08/12/x.json',
      'profiles/personal/memory/main/note.md',
      'data/gmail/ada_lovelace/attachments/x.pdf',
    ]) {
      expect(isWorkspaceConfig(key)).toBe(false);
    }
  });

  test('the authored areas match whole segments, never prefixes', () => {
    // The allowlist names two areas inside a tree it otherwise refuses
    // wholesale. A prefix match would send anything merely starting with the
    // same letters, and the thing on the other side of that boundary is a
    // profile's sealed vault.
    for (const key of [
      'profiles/personal/skills.detour/leak.md',
      'providers.disabled/acme.yaml',
      'profiles/personal/skills.d',
      'providers.d',
      // The area itself, with a connection but no file — a directory is not a
      // file to send.
      'profiles/personal/skills.d/main',
      'profiles/personal//skills.d/review-diff.md',
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

  test('naming a profile sends only that profile file', () => {
    // A workspace holding personal and work should not push both into a bucket
    // that only one of them is for.
    expect(isWorkspaceConfig('profiles/personal/profile.yaml', ['personal'])).toBe(true);
    expect(isWorkspaceConfig('profiles/work/profile.yaml', ['personal'])).toBe(false);
  });

  test('skills are filtered by profile and manifests are not', () => {
    // The two authored areas sit at different levels and are filtered
    // differently, which follows from where ADR-066 and ADR-057 put them. A
    // manifest is the workspace's — it defines a connection any profile may
    // grant — so it goes up whole. Skills are inside a profile again, so
    // sending them on a deploy that does not carry that profile would put one
    // profile's procedures in front of another's endpoint.
    expect(isWorkspaceConfig('profiles/personal/skills.d/main/a.md', ['personal'])).toBe(true);
    expect(isWorkspaceConfig('profiles/work/skills.d/main/a.md', ['personal'])).toBe(false);

    expect(isWorkspaceConfig('providers.d/acme.yaml', ['personal'])).toBe(true);
    expect(isWorkspaceConfig('providers.d/acme.yaml', ['work'])).toBe(true);
  });

  test('a profile keeps its state, its vault and its blobs to itself', () => {
    // Everything else under `profiles/<name>/` is state, a sealed vault, or a
    // provider's own bytes — none of it configuration, and the vault is a
    // credential. Named here because the profile directory is now inside the
    // allowlist's reach, where before `data/` excluded the lot.
    for (const key of [
      'profiles/personal/state.kv/cursors%2Ev1/x.json',
      'profiles/personal/vault.d/main.enc',
      'profiles/personal/vault.d/main.enc.key',
      'profiles/personal/memory/main/note.md',
      'profiles/personal/gmail/ada_lovelace/attachments/x.pdf',
      'credentials.enc',
      'credentials.enc.key',
    ]) {
      expect({ key, sent: isWorkspaceConfig(key, ['personal']) }).toEqual({ key, sent: false });
    }
  });

  test('the connections file always goes, and the registry never does', () => {
    // The endpoint cannot resolve a single grant without connections.yaml, and
    // there is nothing machine-specific in it. The registry is the opposite: it
    // holds this machine's pointer, and copying it into the bucket left the
    // bucket pointing at itself (ADR-052).
    expect(isWorkspaceConfig('connections.yaml')).toBe(true);
    expect(isWorkspaceConfig('connections.yaml', ['personal'])).toBe(true);
    expect(isWorkspaceConfig('workspaces.yaml')).toBe(false);
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
  const OLD = (name: string) => `contract: 4
instance:
  profile: ${name}
  port: 7337
grants:
  - { connection: example.a, allow: [example.*], deny: [] }
members: []
`;

  /** The workspace it lives in, with the account and no owner-layer row. */
  const OLD_CONNECTIONS = `contract: 4
connections:
  - { id: a, provider: example, account: someone@example.test }
oauth_apps: {}
`;

  async function workspace(...profiles: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-deploy-'));
    roots.push(root);
    await mkdir(join(root, 'profiles', 'personal'), { recursive: true });
    for (const name of profiles) {
      await writeProfileFixture(root, name, OLD(name));
    }
    await writeFile(join(root, CONNECTIONS_FILE), OLD_CONNECTIONS);
    return root;
  }

  // The grant is what says the surface is reachable now: a row *is* the
  // connection and the rule together (ADR-058), so there is no second half to
  // check for.
  const has = async (root: string, key: string): Promise<boolean> =>
    (await readFile(join(root, 'profiles', key), 'utf8')).includes('connection: lanes_setup.');

  test('every profile it would upload, when none is named', async () => {
    const root = await workspace('personal', 'work');

    await repairOwnerLayer(root, undefined);

    // `work` is going to the bucket too, so it is going to be served. Repairing
    // a narrower set than the upload sends would leave it served and dark,
    // which is this bug one profile over.
    expect(await has(root, 'personal/profile.yaml')).toBe(true);
    expect(await has(root, 'work/profile.yaml')).toBe(true);
  });

  test('only the named one, matching what the upload sends', async () => {
    const root = await workspace('personal', 'work');

    await repairOwnerLayer(root, ['personal']);

    expect(await has(root, 'personal/profile.yaml')).toBe(true);
    // Not touched: it is not going up, so editing it would be this command
    // changing config it was not asked about.
    expect(await has(root, 'work/profile.yaml')).toBe(false);
  });

  test('reports where it is told to, so a --json caller keeps its stdout', async () => {
    // `lanes link update` repairs on the way past and can be asked for a
    // document. The repair still says what it widened — a policy edit nobody
    // asked for is not a thing to do quietly — it just says it somewhere that
    // does not corrupt the answer.
    const root = await workspace('personal');
    const lines: string[] = [];

    await repairOwnerLayer(root, undefined, { report: (line) => lines.push(line) });

    expect(await has(root, 'personal/profile.yaml')).toBe(true);
    expect(lines.join('\n')).toContain('owner layer');
  });

  test('a profile that already has it is left byte-identical', async () => {
    const root = await workspace('personal');
    await repairOwnerLayer(root, undefined);
    const after = await readFile(join(root, 'profiles', 'personal', 'profile.yaml'), 'utf8');

    await repairOwnerLayer(root, undefined);

    expect(await readFile(join(root, 'profiles', 'personal', 'profile.yaml'), 'utf8')).toBe(after);
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
      await write(root, 'personal.example.yaml', OLD('personal'));

      await repairOwnerLayer(root, undefined);

      expect(await has(root, 'personal/profile.yaml')).toBe(true);
      expect(await readFile(join(root, 'profiles', 'personal.example.yaml'), 'utf8')).toBe(
        OLD('personal'),
      );
    });

    test('a nested directory under profiles/ is not a profile', async () => {
      const root = await workspace('personal');
      // Neither shape counts: `archive/old.yaml` is not a profile at the
      // contract-3 spelling, and `archive/old/profile.yaml` is not one at the
      // contract-4 spelling either — a profile is a *direct* child of
      // `profiles/`, and a bucket listing is flat so a nested one would
      // otherwise look like one.
      await write(root, 'archive/old.yaml', OLD('old'));
      await write(root, 'archive/old/profile.yaml', OLD('old'));

      await repairOwnerLayer(root, undefined);

      expect(await has(root, 'personal/profile.yaml')).toBe(true);
      expect(await has(root, 'archive/old/profile.yaml')).toBe(false);
      expect(await has(root, 'archive/old.yaml')).toBe(false);
    });

    test('a profile that cannot be read is warned about, not fatal', async () => {
      const root = await workspace('personal', 'work');
      await writeProfileFixture(root, 'work', 'a: [1, 2\n');

      // The upload that follows still sends it, which is what happened before
      // this function existed — repairing is a courtesy on the way past, and a
      // sibling nobody named should not cost the operator their rollout.
      await repairOwnerLayer(root, undefined);

      expect(await has(root, 'personal/profile.yaml')).toBe(true);
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
  // The rows are the workspace's now, so a "profile" in these fixtures is the
  // set of connections it grants and the file that grants them (ADR-057).
  const PROFILE = (name: string, connections: string) => `contract: 4
instance:
  profile: ${name}
grants:
${connections
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    const id = /id:\s*([a-z0-9_]+)/.exec(line)?.[1] ?? '';
    const provider = /provider:\s*([a-z0-9_]+)/.exec(line)?.[1] ?? '';
    return `  - { connection: ${provider}.${id}, allow: ['${provider}.*'], deny: [] }`;
  })
  .join('\n')}
members: []
`;

  async function workspaceOf(profiles: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-rotatable-'));
    roots.push(root);
    await mkdir(join(root, 'profiles', 'personal'), { recursive: true });

    const rows: string[] = [];
    for (const [name, connections] of Object.entries(profiles)) {
      await writeProfileFixture(root, name, PROFILE(name, connections));
      rows.push(connections);
    }

    await writeFile(
      join(root, CONNECTIONS_FILE),
      `contract: 4\nconnections:\n${rows.join('\n')}\noauth_apps: {}\n`,
    );
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
    expect(await rotatableRefs(root, undefined, undefined)).toEqual([
      'gmail/ada_lovelace',
      'gmail/rin_shaw',
    ]);
  });

  const vaultTarget = (vault: TargetConfig['vault']): TargetConfig =>
    ({
      credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
      storage: { adapter: 'gcs', bucket: 'your-bucket' },
      vault,
    }) as TargetConfig;

  test('the vault document is named per profile and connection, the way openVault opens it', async () => {
    // The blocker this pins. `openVault` names the document
    // `vault/<profile>/<connection>` (ADR-059, ADR-066); `provisionSteps` named
    // `vault/document`, the contract-2
    // constant. So a deploy created and granted one secret and the revision
    // asked Secret Manager for another, got `PERMISSION_DENIED`, exited 1, and
    // never listened on its port — on every deployed workspace that did not
    // hand-write `vault.ref`. A rehearsal that sets one tests the path nobody
    // takes, which is exactly how this reached a live endpoint.
    //
    // Both sets, because the revision reads the document at startup and writes
    // it back under policy (ADR-022): a ref in only one of them is the same 403.
    // Granting no vault is the ordinary case and resolves to `main`, which is
    // what keeps a profile that denied the vault opening the same document as
    // everyone else rather than inventing a second one.
    const root = await workspaceOf({
      personal: '  - { id: ada_lovelace, provider: gmail, account: a@example.test }',
    });
    const declared = vaultTarget({ adapter: 'secret' });

    expect(await rotatableRefs(root, undefined, declared)).toContain('vault/personal/main');
    expect(await readableRefs(root, undefined, declared)).toContain('vault/personal/main');
    expect(await rotatableRefs(root, undefined, declared)).not.toContain('vault/document');
  });

  test('a hand-written ref still wins, because a sealed document keeps its name', async () => {
    const root = await workspaceOf({
      personal: '  - { id: ada_lovelace, provider: gmail, account: a@example.test }',
    });
    const declared = vaultTarget({ adapter: 'secret', ref: 'vault/kept' });

    expect(await rotatableRefs(root, undefined, declared)).toContain('vault/kept');
  });

  test('a provider that authenticates with nothing contributes nothing', async () => {
    const root = await workspaceOf({ personal: '  - { id: main, provider: example, account: local }' });

    // A grant on a secret nobody writes is a grant that says the boundary is
    // wider than it is.
    expect(await rotatableRefs(root, undefined, undefined)).toEqual([]);
  });

  test('every profile the upload sends, when none is named', async () => {
    // The same scoping `repairOwnerLayer` has, and for a sharper reason: a
    // deploy with no `--profile` sends the whole workspace up, so binding only
    // the resolved profile leaves the others served and 403ing an hour later.
    const root = await workspaceOf({
      personal: '  - { id: mine, provider: gmail, account: a@example.test }',
      work: '  - { id: theirs, provider: gmail, account: b@example.test }',
    });

    expect(await rotatableRefs(root, undefined, undefined)).toEqual(['gmail/mine', 'gmail/theirs']);
  });

  test('naming a profile changes nothing, because the accounts are the workspace\'s', async () => {
    const root = await workspaceOf({
      personal: '  - { id: mine, provider: gmail, account: a@example.test }',
      work: '  - { id: theirs, provider: gmail, account: b@example.test }',
    });

    // This narrowed by profile until contract 3, on the reasoning that a
    // profile not going up is not served. A connection belongs to the workspace
    // now (ADR-057) and `connections.yaml` always goes up, so every account is
    // served whichever profiles were named — and a credential the revision
    // cannot read is a broken account, not a boundary being widened.
    expect(await rotatableRefs(root, ['personal'], undefined)).toEqual(['gmail/mine', 'gmail/theirs']);
  });

  test('a profile that cannot be read is skipped, not fatal', async () => {
    const root = await workspaceOf({
      personal: '  - { id: mine, provider: gmail, account: a@example.test }',
    });
    await writeProfileFixture(root, 'work', 'a: [1, 2\n');

    // Matching the repair: a broken sibling nobody named should not cost the
    // operator a rollout, and provisioning happens before anything is uploaded.
    expect(await rotatableRefs(root, undefined, undefined)).toEqual(['gmail/mine']);
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
contract: 4
instance:
  profile: personal
  port: 7337
${extra}
grants: []
members: []
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
    // The destination is derived from the target, never passed in — which is
    // the whole of what `publishWorkspace` adds over `uploadWorkspace`. Driving
    // the copy itself would need a bucket; the allowlist that governs it is
    // covered above.
    //
    // Read off the target rather than off a profile: a profile declares none
    // (ADR-052), so `deployedWorkspace` takes the adapter set the registry
    // holds.
    expect(
      deployedWorkspace({
        credentials: { adapter: 'file' },
        storage: { adapter: 'gcs', bucket: 'your-bucket', prefix: 'workspace' },
      }),
    ).toBe('gs://your-bucket/workspace');

    expect(
      deployedWorkspace({
        credentials: { adapter: 'file' },
        storage: { adapter: 'filesystem' },
      }),
    ).toBeUndefined();
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

    const profile = (name: string): string =>
      `contract: 4\ninstance:\n  profile: ${name}\ngrants: []\nmembers: []\n`;

    const files: Record<string, string> = {
      'workspaces.yaml': workspaceYaml(['local', 'cloud'], { defaultProfile: 'personal' }),
      'profiles/personal/profile.yaml': profile('personal'),
      'profiles/work/profile.yaml': profile('work'),
      'connections.yaml': `contract: 4\nconnections: []\noauth_apps: {}\n`,
      [`${layout.skills('personal', 'main')}/review-diff/SKILL.md`]: '---\ndescription: d\n---\nb\n',
      [`${layout.skills('work', 'main')}/triage.md`]: '---\ndescription: d\n---\nb\n',
      ['providers.d/acme.yaml']: 'id: acme\n',
      'credentials.enc': 'ciphertext',
      'credentials.enc.key': 'the key that opens it',
      'profiles/personal/vault.d/main.enc': 'ciphertext',
      'state.kv/connections%2Ev1/example%2Ea.json': '{}',
      'audit.log/2026/08/24/x.json': '{}',
      'profiles/personal/memory/main/note.md': 'a note',
      'profiles/personal/example/a/attachments/x.pdf': 'bytes',
    };

    for (const [key, contents] of Object.entries(files)) {
      await mkdir(join(source, key, '..'), { recursive: true });
      await writeFile(join(source, key), contents);
    }

    return { source, destination };
  }

  const landed = async (root: string): Promise<string[]> =>
    (await workspaceFiles(root).list('')).map((entry) => entry.key).sort();

  test('the whole workspace goes, and nothing a revision writes does', async () => {
    const { source, destination } = await populated();

    await uploadWorkspace(source, destination, undefined);

    expect(await landed(destination)).toEqual([
      'connections.yaml',
      'profiles/personal/profile.yaml',
      'profiles/personal/skills.d/main/review-diff/SKILL.md',
      'profiles/work/profile.yaml',
      'profiles/work/skills.d/main/triage.md',
      'providers.d/acme.yaml',
    ]);
  });

  test('naming a profile narrows the profile files and nothing else', async () => {
    const { source, destination } = await populated();

    await uploadWorkspace(source, destination, ['personal']);

    // Both halves of the filter, in one listing: `work`'s declaration *and*
    // its skills stay behind, because skills are inside a profile again
    // (ADR-066). The manifest still goes — it is the workspace's, and defines a
    // connection any profile may grant (ADR-057).
    expect(await landed(destination)).toEqual([
      'connections.yaml',
      'profiles/personal/profile.yaml',
      'profiles/personal/skills.d/main/review-diff/SKILL.md',
      'providers.d/acme.yaml',
    ]);
  });

  test('the source really does offer the credential store to the filter', async () => {
    // Without this, the test above passes just as well against a listing that
    // never descends into `data/` — which would mean the skills never go up
    // either, silently.
    const { source } = await populated();

    expect(await landed(source)).toContain('credentials.enc.key');
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

/**
 * What a deploy tells an operator whose clients are already registered.
 *
 * ADR-032 covers the first deploy: register before the accounts exist and the
 * client holds a two-tool surface. The case it left unsaid is every deploy after
 * that one, and 0.9.0 is what made it expensive — renaming the owner layer's
 * provider ids renamed their tools, so a registered client went on calling
 * `setup_overview` against an endpoint serving `lanes_setup_overview` and read as
 * a broken endpoint rather than a stale list. `sayContract4` says it when the
 * migration runs; a deploy is when it reaches anybody.
 */
describe('the deploy report names the re-add', () => {
  test('an already-registered client is told, and given the command', () => {
    const line = registerLine('personal', 'cloud');

    expect(line).toContain('registered before this deploy');
    expect(line).toContain('lanes link mcp add');
  });
});
