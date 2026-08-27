import { workspaceYaml } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '#profile';
import { openRuntime, type Runtime } from '../runtime.ts';

/**
 * That a profile's owner layer is the profile's — ADR-030.
 *
 * Skills and provider manifests used to live at the workspace root, shared by
 * every profile, with policy gating `skills.<name>` as the whole isolation
 * story. Policy decides who may *run* a procedure; it never hid that the
 * procedure existed, or what it said, or which host a manifest names.
 *
 * These tests open two real runtimes over one real workspace, because that is
 * the only arrangement where the bug was reachable: one profile is never wrong
 * about whose skills it is holding.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

const profileConfig = (name: string): string => `contract: 2

instance:
  profile: ${name}

policy:
  allow: ['*']
`;

const skill = (description: string, body: string): string =>
  `---\ndescription: ${description}\n---\n${body}\n`;

const manifest = (id: string, host: string): string =>
  `id: ${id}\nname: ${id}\nconnector: { kind: http, base_url: https://${host}, openapi: https://${host}/openapi.json }\nauth: { kind: header, header: X-API-Key, credential_ref: ${id}/api_key }\n`;

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-scoping-'));
  roots.push(root);

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'lanes-link.yaml'), workspaceYaml(['local'], {defaultProfile: 'personal'}));
  for (const name of ['personal', 'work']) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), profileConfig(name));
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

describe('skills belong to one profile', () => {
  test("a profile's skills are invisible to its sibling", async () => {
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
        new TextDecoder().decode((await runtime.skills.get('triage.md'))!);

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

describe('provider manifests belong to one profile', () => {
  test('a manifest one profile declares is not registered in the other', async () => {
    await workspace({
      [`${layout.providers('work')}/ledger.yaml`]: manifest('ledger', 'ledger.example.com'),
    });

    // `has`, not `capabilities()`: an http provider's capability list comes
    // from its OpenAPI document, which nothing here fetches. Whether the
    // manifest was registered at all is the question this change decides.
    await bothProfiles(async ({ personal, work }) => {
      expect(work.registry.has('ledger')).toBe(true);
      expect(personal.registry.has('ledger')).toBe(false);
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
