import { workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIONS_FILE, layout } from '#profile';
import { openRuntime, type Runtime } from '../runtime.ts';

/**
 * That a profile's skills are its own, whichever instance it grants — ADR-066.
 *
 * Skills lived at the workspace root once, shared by every profile, with policy
 * gating `skills.<name>` as the whole isolation story; ADR-030 moved them into
 * the profile because policy decides who may *run* a procedure and never hid
 * that the procedure existed. ADR-059 then moved them out again, to the skills
 * *connection*, which made sharing the owner's choice — and made the shipped
 * default sharing, because every profile is created granting the same instance.
 *
 * ADR-066 puts the profile back in front of the connection. Both segments are
 * in the path, so the instance still lets one profile hold two sets, and the
 * profile is once again a wall rather than a convention.
 *
 * The case that decides it is two profiles granting **one** instance. Under
 * ADR-059 that is one directory and one set of procedures; here it is two, and
 * the first test below is that assertion and nothing else.
 *
 * These tests open two real runtimes over one real workspace, because that is
 * the only arrangement where the bug was reachable: one profile is never wrong
 * about whose skills it is holding.
 *
 * Manifests are the exception and stay at the workspace (ADR-057): a manifest
 * defines a connection, and connections are the workspace's, so one profile's
 * manifest *is* the other's.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

const profileConfig = (name: string, skills = name): string => `contract: 3

instance:
  profile: ${name}

grants:
  - { connection: skills.${skills}, allow: ['skills.*'], deny: [] }
  - { connection: setup.main, allow: ['setup.*'], deny: [] }
members: []
`;

/** The workspace's rows: one skills instance per profile, plus the owner layer. */
const CONNECTIONS = `contract: 3
connections:
  - { id: personal, provider: skills, account: Skills }
  - { id: work, provider: skills, account: Skills }
  - { id: shared, provider: skills, account: Skills }
  - { id: main, provider: setup, account: Setup }
oauth_apps: {}
`;

const skill = (description: string, body: string): string =>
  `---\ndescription: ${description}\n---\n${body}\n`;

const manifest = (id: string, host: string): string =>
  `id: ${id}\nname: ${id}\nconnector: { kind: http, base_url: https://${host}, openapi: https://${host}/openapi.json }\nauth: { kind: header, header: X-API-Key, credential_ref: ${id}/api_key }\n`;

async function workspace(
  files: Record<string, string>,
  granting?: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-scoping-'));
  roots.push(root);

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local'], {defaultProfile: 'personal'}));
  await writeFile(join(root, CONNECTIONS_FILE), CONNECTIONS);
  for (const name of ['personal', 'work']) {
    await writeProfileFixture(root, name, profileConfig(name, granting?.[name]));
  }

  for (const [key, contents] of Object.entries(files)) {
    await mkdir(join(root, key, '..'), { recursive: true });
    await writeFile(join(root, key), contents);
  }

  process.env['LANES_LINK_HOME'] = root;
  return root;
}

/** Both runtimes, closed however the assertions end. */
async function bothProfiles<T>(
  body: (runtimes: Record<'personal' | 'work', Runtime>) => Promise<T>,
): Promise<T> {
  const personal = await openRuntime({ target: 'local', profile: 'personal' });
  const work = await openRuntime({ target: 'local', profile: 'work' });

  try {
    return await body({ personal, work });
  } finally {
    await personal.close();
    await work.close();
  }
}

const capabilities = (runtime: Runtime): string[] =>
  runtime.registry.capabilities().map((entry) => entry.id);

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('a profile owns its skills, whichever instance it grants', () => {
  test('two profiles granting one instance still share nothing', async () => {
    // The ADR-066 assertion. Both profiles grant `skills.shared` — the same
    // row, the same id — and each still reads only what was written under its
    // own directory. Under ADR-059 this fixture was one store and both files
    // would appear on both sides.
    //
    // Written as two distinct skills rather than a subset of one set: a fixture
    // where one side's content is contained in the other's cannot tell
    // isolation from sharing.
    await workspace(
      {
        [`${layout.skills('personal', 'shared')}/holiday-plan/SKILL.md`]: skill('Plan a holiday', 'Plan it.'),
        [`${layout.skills('work', 'shared')}/incident-review/SKILL.md`]: skill('Review an incident', 'Review it.'),
      },
      { personal: 'shared', work: 'shared' },
    );

    await bothProfiles(async ({ personal, work }) => {
      expect(capabilities(personal)).toContain('skills.holiday-plan');
      expect(capabilities(personal)).not.toContain('skills.incident-review');

      expect(capabilities(work)).toContain('skills.incident-review');
      expect(capabilities(work)).not.toContain('skills.holiday-plan');
    });
  });

  test('one name under one instance is two different procedures', async () => {
    // The sharpest form of the same thing: same capability id, same connection
    // id, different bytes. A shared directory could not represent this at all —
    // whichever file existed won, for everyone.
    await workspace(
      {
        [`${layout.skills('personal', 'shared')}/triage.md`]: skill('Triage', 'Sort the personal inbox.'),
        [`${layout.skills('work', 'shared')}/triage.md`]: skill('Triage', 'Page the on-call engineer.'),
      },
      { personal: 'shared', work: 'shared' },
    );

    const personal = await openRuntime({ target: 'local', profile: 'personal' });
    const work = await openRuntime({ target: 'local', profile: 'work' });

    try {
      const body = async (runtime: typeof personal): Promise<string> =>
        new TextDecoder().decode((await runtime.skills!.get('triage.md'))!);

      expect(await body(personal)).toContain('Sort the personal inbox.');
      expect(await body(work)).toContain('Page the on-call engineer.');
    } finally {
      await personal.close();
      await work.close();
    }
  });

  test('the instance still separates two sets inside one profile', async () => {
    // The half of ADR-059 that survives. A profile grants one skills connection
    // (`SINGLE_INSTANCE_PROVIDERS`), so the two sets here belong to different
    // profiles — what is being pinned is that the connection segment is still
    // in the path and still decides, rather than being ignored now that the
    // profile is in front of it.
    await workspace({
      [`${layout.skills('personal', 'personal')}/holiday-plan/SKILL.md`]: skill('Plan a holiday', 'Plan it.'),
      [`${layout.skills('personal', 'shared')}/incident-review/SKILL.md`]: skill('Review an incident', 'Review it.'),
    });

    await bothProfiles(async ({ personal }) => {
      expect(capabilities(personal)).toContain('skills.holiday-plan');
      expect(capabilities(personal)).not.toContain('skills.incident-review');
    });
  });

  test('a skill left at either old path loads for nobody', async () => {
    // No migration for the workspace-root layout, deliberately — `layout.ts`
    // says so. The contract-3 path is migrated, and this pins the failure mode
    // for anything left behind: absent, not silently serving every profile.
    await workspace({
      'skills/review-diff/SKILL.md': skill('Review a diff', 'Review it.'),
      'data/skills.d/personal/triage/SKILL.md': skill('Triage', 'Sort it.'),
    });

    await bothProfiles(async ({ personal, work }) => {
      expect(capabilities(personal)).not.toContain('skills.review-diff');
      expect(capabilities(work)).not.toContain('skills.review-diff');
      expect(capabilities(personal)).not.toContain('skills.triage');
    });
  });
});

describe('provider manifests belong to the workspace', () => {
  test('a manifest is registered in every profile, because it defines a connection', async () => {
    // The reversal ADR-057 makes, and the one place this file moves the other
    // way. ADR-030 put manifests in the profile on the reasoning that a manifest
    // "names a host, an OpenAPI document, and the credential refs that reach
    // them" — a description of somebody's infrastructure. That is still true,
    // and it is now a description of a *connection*, which the workspace owns.
    //
    // What keeps the boundary is the grant: a profile that does not grant
    // `ledger.<id>` reaches nothing through it, however registered it is.
    await workspace({
      [`${layout.providers()}/ledger.yaml`]: manifest('ledger', 'ledger.example.com'),
    });

    // `has`, not `capabilities()`: an http provider's capability list comes
    // from its OpenAPI document, which nothing here fetches. Whether the
    // manifest was registered at all is the question this change decides.
    await bothProfiles(async ({ personal, work }) => {
      expect(work.registry.has('ledger')).toBe(true);
      expect(personal.registry.has('ledger')).toBe(true);
    });
  });

  test('a manifest left at the old workspace path is not registered either', async () => {
    await workspace({ 'providers/ledger.yaml': manifest('ledger', 'ledger.example.com') });

    await bothProfiles(async ({ personal, work }) => {
      expect(personal.registry.has('ledger')).toBe(false);
      expect(work.registry.has('ledger')).toBe(false);
    });
  });
});
