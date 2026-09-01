import { workspaceYaml } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIONS_FILE, layout } from '#profile';
import { openRuntime, type Runtime } from '../runtime.ts';

/**
 * That skills follow the instance a profile grants — ADR-059.
 *
 * Skills lived at the workspace root once, shared by every profile, with policy
 * gating `skills.<name>` as the whole isolation story; ADR-030 moved them into
 * the profile because policy decides who may *run* a procedure and never hid
 * that the procedure existed. ADR-059 keeps that isolation and changes what
 * expresses it: a skills connection, granted by name, so two profiles share
 * nothing by granting different instances and share everything by granting one.
 *
 * The privacy argument is unchanged. What changed is that the owner chooses,
 * where the file path used to choose for them.
 *
 * These tests open two real runtimes over one real workspace, because that is
 * the only arrangement where the bug was reachable: one profile is never wrong
 * about whose skills it is holding.
 *
 * Manifests are the exception and moved the other way (ADR-057): a manifest
 * defines a connection, and connections are the workspace's, so one profile's
 * manifest *is* the other's now.
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
  await writeFile(join(root, 'lanes-link.yaml'), workspaceYaml(['local'], {defaultProfile: 'personal'}));
  await writeFile(join(root, CONNECTIONS_FILE), CONNECTIONS);
  for (const name of ['personal', 'work']) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), profileConfig(name, granting?.[name]));
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

describe('skills follow the instance a profile grants', () => {
  test("a profile's skills are invisible to a sibling granting a different instance", async () => {
    await workspace({
      [`${layout.skills('personal')}/holiday-plan/SKILL.md`]: skill('Plan a holiday', 'Plan it.'),
      [`${layout.skills('work')}/incident-review/SKILL.md`]: skill('Review an incident', 'Review it.'),
    });

    await bothProfiles(async ({ personal, work }) => {
      expect(capabilities(personal)).toContain('skills.holiday-plan');
      expect(capabilities(personal)).not.toContain('skills.incident-review');

      expect(capabilities(work)).toContain('skills.incident-review');
      expect(capabilities(work)).not.toContain('skills.holiday-plan');
    });
  });

  test('one name in two profiles is two different procedures', async () => {
    // The capability id is the same on both sides, which is the case a shared
    // directory could not represent at all: whichever file existed won, for
    // everyone. Here each store answers for its own profile.
    await workspace({
      [`${layout.skills('personal')}/triage.md`]: skill('Triage', 'Sort the personal inbox.'),
      [`${layout.skills('work')}/triage.md`]: skill('Triage', 'Page the on-call engineer.'),
    });

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

  test('a skill left at the old workspace path loads for nobody', async () => {
    // No migration, deliberately — `profile/layout.ts` says so. The failure
    // mode worth pinning is that it is *absent*, not that it silently keeps
    // working for every profile.
    await workspace({
      'skills/review-diff/SKILL.md': skill('Review a diff', 'Review it.'),
    });

    await bothProfiles(async ({ personal, work }) => {
      expect(capabilities(personal)).not.toContain('skills.review-diff');
      expect(capabilities(work)).not.toContain('skills.review-diff');
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
