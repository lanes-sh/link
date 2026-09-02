import { CONNECTIONS_FILE } from '#profile';
import { connectionsYaml, workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGithub, type FakeGithub } from '#deployments/adapters/github-testing.ts';
import { GithubRepository } from '#deployments/adapters/github-repo.ts';
import { openSecretStoreFor, resolveProfile } from '../../runtime.ts';
import { doctor } from '../operate.ts';
import { targetShow } from '../target.ts';
import { removeProfile } from '../profile/remove.ts';
import { knowledgeUse } from './index.ts';
import { knowledgeShow } from './show.ts';
import { probe } from './setup.ts';

/**
 * `lanes link knowledge`, against a real workspace on disk and a repository
 * that only exists in memory.
 *
 * The ordering is what these are for. Everything the command does before it
 * edits config can fail, and a profile that has been half-switched — a config
 * naming a repository that does not hold the entries, or local files deleted
 * against a commit that did not land — is a worse outcome than any of the
 * failures themselves. So each refusal is asserted together with the state it
 * must have left behind.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

const PROFILE = `contract: 3

instance:
  profile: personal

grants:
  - { connection: memory.main, allow: [memory.*], deny: [] }
  - { connection: skills.main, allow: [skills.*], deny: [] }
  - { connection: entities.main, allow: [entities.*], deny: [] }
members: []
`;

/**
 * Every command names its profile and its target now — nothing else selects one
 * (ADR-037). Spread rather than repeated, so a test says what it is about and
 * not which flags the CLI requires.
 */
const SELECT = { profile: 'personal', target: 'local' } as const;

const SKILL = '---\ndescription: Triage an inbox\n---\nOpen the inbox.\n';
const ENTITY = '---\ntype: person\nname: Jan Bakker\n---\n\nPrefers email.\n';
const ENTRY = '---\ntitle: A note\nupdated_at: 2026-01-01T00:00:00.000Z\n---\nBody.\n';

async function workspace(seed = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-knowledge-'));
  roots.push(root);

  await mkdir(join(root, 'profiles', 'personal'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local'], {defaultProfile: 'personal'}));
  await writeProfileFixture(root, 'personal', PROFILE);
  await writeFile(join(root, CONNECTIONS_FILE), connectionsYaml());

  if (seed) {
    await mkdir(join(root, 'data/memory/main'), { recursive: true });
    await writeFile(join(root, 'data/memory/main/a-note.md'), ENTRY);
    await mkdir(join(root, 'data/skills.d/main/triage'), { recursive: true });
    await writeFile(join(root, 'data/skills.d/main/triage/SKILL.md'), SKILL);
    await mkdir(join(root, 'data/entities/main'), { recursive: true });
    await writeFile(join(root, 'data/entities/main/jan-bakker.md'), ENTITY);
    await writeFile(join(root, 'data/entities/main/_index.json'), '{"v":1}');
  }

  process.env['LANES_LINK_HOME'] = root;

  // The token, stored ahead of time so nothing prompts. The command reads it
  // from the target's own credential store, exactly as it would after a first
  // interactive run.
  const { resolution, config } = await resolveProfile(SELECT);
  const secrets = await openSecretStoreFor(config, resolution.workspaceRoot, 'local');
  await secrets.set('knowledge/token', 'github_pat_stub');

  return root;
}

const readProfile = (root: string) => readFile(join(root, 'profiles', 'personal', 'profile.yaml'), 'utf8');

let github: FakeGithub;
beforeEach(() => {
  github = createFakeGithub();
});

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
});

const use = (extra: Record<string, unknown> = {}) =>
  knowledgeUse('github', {
    ...SELECT,
    repo: 'my-org/my-notes',
    fetch: github.fetch,
    yes: true,
    ...extra,
  });

describe('switching to a repository', () => {
  test('moves what is stored, in one commit, and then removes it locally', async () => {
    const root = await workspace();

    await use({ migrate: true });

    expect(github.files()).toEqual({
      'memory/main/a-note.md': ENTRY,
      'skills/triage/SKILL.md': SKILL,
      'entities/main/jan-bakker.md': ENTITY,
      // The derived index travels with the documents it describes. Asserted
      // rather than tolerated: it is a cache in a documents repository, which
      // is a real cost of committing it, and it should be a decision somebody
      // made rather than something that happened.
      'entities/main/_index.json': '{"v":1}',
    });
    // One commit for all of them, not one each.
    expect(github.calls.filter((call) => call.includes('/git/commits')).length).toBe(1);

    expect(existsSync(join(root, 'data/memory/main/a-note.md'))).toBe(false);
    expect(existsSync(join(root, 'data/skills.d/main/triage/SKILL.md'))).toBe(false);
    expect(existsSync(join(root, 'data/entities/main/jan-bakker.md'))).toBe(false);
  });

  test('writes one block, on the profile', async () => {
    // It used to write the same block into every target the profile declared —
    // a per-profile fact stored per target, and the loop that kept them in step.
    // A profile lives in one target now (ADR-052), so the block sits on the
    // profile and there is one of it.
    const root = await workspace();

    await use({ migrate: true });

    const written = await readProfile(root);
    expect(written.match(/repo: my-org\/my-notes/g)).toHaveLength(1);
    expect(written).toContain('token_ref: knowledge/token');
  });

  test('--keep verifies the repository and leaves the local copies behind', async () => {
    const root = await workspace();

    await use({ migrate: true, keep: true });

    expect(Object.keys(github.files())).toHaveLength(4);
    expect(existsSync(join(root, 'data/memory/main/a-note.md'))).toBe(true);
    expect(existsSync(join(root, 'data/entities/main/jan-bakker.md'))).toBe(true);
  });

  test('--no-migrate switches and leaves what is stored where it is', async () => {
    const root = await workspace();

    await use({ migrate: false });

    expect(github.files()).toEqual({});
    expect(existsSync(join(root, 'data/memory/main/a-note.md'))).toBe(true);
    expect(await readProfile(root)).toContain('repo: my-org/my-notes');
  });

  test('saying neither, with content and no terminal, refuses rather than guessing', async () => {
    const root = await workspace();

    await expect(
      knowledgeUse('github', { ...SELECT, repo: 'my-org/my-notes', fetch: github.fetch }),
    ).rejects.toThrow(/--migrate to move what is stored, --no-migrate to leave it/);

    expect(await readProfile(root)).not.toContain('knowledge:');
  });

  test('an empty profile needs no migration at all', async () => {
    const root = await workspace(false);

    await use();

    expect(github.files()).toEqual({});
    expect(await readProfile(root)).toContain('repo: my-org/my-notes');
  });

  test('a pasted URL is accepted and written as owner/name', async () => {
    const root = await workspace(false);

    await use({ repo: 'https://github.com/my-org/my-notes.git' });

    expect(await readProfile(root)).toContain('repo: my-org/my-notes');
  });

  test('a path prefix lands every area under it', async () => {
    await workspace();

    await use({ migrate: true, path: 'context' });

    expect(Object.keys(github.files()).sort()).toEqual([
      'context/entities/main/_index.json',
      'context/entities/main/jan-bakker.md',
      'context/memory/main/a-note.md',
      'context/skills/triage/SKILL.md',
    ]);
  });

  test('a second switch is refused rather than layered on the first', async () => {
    await workspace(false);
    await use();

    await expect(use()).rejects.toThrow(/Already storing knowledge in a repository/);
  });
});

describe('refusals leave the profile exactly as it was', () => {
  test('a public repository is refused, not warned about', async () => {
    const root = await workspace();
    github = createFakeGithub({ private: false });

    await expect(use({ migrate: true })).rejects.toThrow(/is public/);

    expect(await readProfile(root)).not.toContain('knowledge:');
    expect(existsSync(join(root, 'data/memory/main/a-note.md'))).toBe(true);
    expect(github.files()).toEqual({});
  });

  test('--allow-public is how somebody means it', async () => {
    const root = await workspace(false);
    github = createFakeGithub({ private: false });

    await use({ allowPublic: true });

    expect(await readProfile(root)).toContain('repo: my-org/my-notes');
  });

  test('a read-only token is refused before anything is written', async () => {
    const root = await workspace();
    github = createFakeGithub({ canPush: false });

    await expect(use({ migrate: true })).rejects.toThrow(/not write to it/);
    expect(await readProfile(root)).not.toContain('knowledge:');
  });

  test('a repository that is not one is refused before the network', async () => {
    await workspace(false);

    await expect(use({ repo: 'my-org' })).rejects.toThrow(/is not a repository/);
    expect(github.calls).toEqual([]);
  });

  test('a commit that does not read back leaves the local copies alone', async () => {
    const root = await workspace();
    // The commit lands and the tree comes back short — a torn migration, which
    // is the case the verification step exists for.
    github.failNext(
      'GET /repos/my-org/my-notes/git/trees/',
      new Response(JSON.stringify({ tree: [], truncated: false }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(use({ migrate: true })).rejects.toThrow(/did not read back correctly/);

    expect(existsSync(join(root, 'data/memory/main/a-note.md'))).toBe(true);
    expect(await readProfile(root)).not.toContain('knowledge:');
  });

  test('a repository the token cannot reach says which causes are likely', async () => {
    await workspace(false);
    github.failNext('GET /repos/my-org/my-notes', new Response(null, { status: 404 }));

    await expect(use()).rejects.toThrow(/waiting on an\s+organisation owner/);
  });
});

describe('coming back', () => {
  test('writes everything down and removes the block', async () => {
    const root = await workspace();
    await use({ migrate: true });

    await knowledgeUse('local', { ...SELECT, fetch: github.fetch, migrate: true, yes: true });

    expect(await readFile(join(root, 'data/memory/main/a-note.md'), 'utf8')).toBe(ENTRY);
    expect(await readFile(join(root, 'data/skills.d/main/triage/SKILL.md'), 'utf8')).toBe(SKILL);
    expect(await readFile(join(root, 'data/entities/main/jan-bakker.md'), 'utf8')).toBe(
      ENTITY,
    );
    expect(await readProfile(root)).not.toContain('knowledge:');
  });

  test('leaves the repository alone — it is version control', async () => {
    await workspace();
    await use({ migrate: true });

    await knowledgeUse('local', { ...SELECT, fetch: github.fetch, migrate: true, yes: true });

    expect(Object.keys(github.files())).toHaveLength(4);
  });

  test('a profile that never switched is told so rather than edited', async () => {
    const root = await workspace(false);
    const before = await readProfile(root);

    await knowledgeUse('local', { ...SELECT, fetch: github.fetch, migrate: true, yes: true });

    expect(await readProfile(root)).toBe(before);
  });
});

/**
 * Run a command the way a shell would: capture its output, and take the exit
 * code it set.
 *
 * **The exit code has to be put back.** `doctor` and `profile remove` both set
 * `process.exitCode` when they find something wrong — that is their only signal
 * to a script, and it is the behaviour these tests are here to exercise. But the
 * test runner is the same process, so a command that sets it leaves `bun test`
 * exiting non-zero with every test passing: a green suite and a red build, which
 * is the worst way for a CI failure to read. These two are the first tests in
 * this repository to drive either command directly, so this is where the rule
 * gets written down.
 *
 * Returned rather than merely restored, because "does doctor exit non-zero when
 * it finds a problem" is worth asserting rather than only tidying away.
 */
async function run(body: () => Promise<void>): Promise<{ output: string; exitCode: number }> {
  const original = process.stdout.write.bind(process.stdout);
  const before = process.exitCode;
  let captured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }

  const exitCode = Number(process.exitCode ?? 0);
  // `?? 0` rather than the value that was there, because assigning `undefined`
  // does not clear it under Bun — it is ignored, and the 1 a command just set
  // stays set. That silent no-op is the whole bug this helper exists to close,
  // so restoring to an explicit 0 is the only form that actually restores.
  process.exitCode = before ?? 0;
  return { output: captured, exitCode };
}

/** When only the output matters. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  return (await run(body)).output;
}

describe('knowledge show', () => {
  test('names the repository and counts what is in it', async () => {
    await workspace();
    await use({ migrate: true });

    const output = await captureStdout(() => knowledgeShow({ ...SELECT, fetch: github.fetch }));

    expect(output).toContain('github:my-org/my-notes/memory');
    expect(output).toContain('github:my-org/my-notes/skills');
    expect(output).toContain('1 file');
    expect(output).toContain('lanes link knowledge use local --migrate');
  });

  test('names the local directories when nothing has been switched', async () => {
    await workspace();

    const output = await captureStdout(() => knowledgeShow({ ...SELECT }));

    expect(output).toContain('data/skills.d');
    expect(output).toContain('lanes link knowledge use github');
  });

  test('--json says where, and how many, and nothing else', async () => {
    await workspace();
    await use({ migrate: true });

    const output = await captureStdout(() => knowledgeShow({ ...SELECT, fetch: github.fetch, json: true }));

    expect(JSON.parse(output)).toEqual({
      target: 'local',
      where: 'github:my-org/my-notes',
      memory: 1,
      skills: 1,
      // Two: the entity document and its derived index, which is a file in that
      // directory like any other and is counted as one.
      entities: 2,
    });
  });
});

describe('the probe', () => {
  test('reports who the token is and what the repository allows', async () => {
    const repository = new GithubRepository({
      repo: 'my-org/my-notes',
      token: 'github_pat_stub',
      fetch: github.fetch,
      freshnessMs: 0,
    });

    expect(await probe(repository, {})).toEqual({
      viewer: 'an-owner',
      facts: {
        fullName: 'my-org/my-notes',
        private: true,
        defaultBranch: 'main',
        canPush: true,
        empty: true,
      },
    });
  });
});

describe('saying where it is, without reading the YAML', () => {
  test('target show names the target’s adapters, and not the repository', async () => {
    // The repository is the *profile's* — where its memory and skills live — and
    // `target show` answers for a target, which several profiles may share.
    // Reporting one profile's repository there would attribute it to all of
    // them. `doctor` below is what says where a profile's knowledge is, and it
    // opens the runtime that knows.
    await workspace(false);
    await use();

    const output = await captureStdout(() => targetShow('local', { target: 'local' }));

    expect(output).toContain('filesystem');
    expect(output).not.toContain('github:my-org/my-notes');
  });

  test('doctor reports the repository as reachable, and exits clean', async () => {
    await workspace(false);
    await use();

    const { output, exitCode } = await run(() => doctor({ ...SELECT, fetch: github.fetch }));

    expect(output).toContain('memory and skills reachable in my-org/my-notes');
    expect(exitCode).toBe(0);
  });

  test('doctor calls a token that has stopped being able to write a problem', async () => {
    await workspace(false);
    await use();
    // The failure this check exists for: the token expires or is narrowed, and
    // nothing says so until the next write.
    github = createFakeGithub({ canPush: false });

    const { output, exitCode } = await run(() =>
      doctor({ ...SELECT, fetch: github.fetch, json: true }),
    );

    const findings = JSON.parse(output) as { problems: Array<{ kind: string }> };
    expect(findings.problems.map((finding) => finding.kind)).toContain('knowledge_read_only');
    // A script's only signal that something is wrong.
    expect(exitCode).toBe(1);
  });

  test('doctor reports a repository it cannot reach at all', async () => {
    await workspace(false);
    await use();
    // An expired token is a state, not a race: every request fails until it is
    // replaced. The runtime has to open anyway, or the command that replaces it
    // cannot run either.
    github.failEvery('/repos/my-org/my-notes', () => new Response(null, { status: 401 }));

    const { output, exitCode } = await run(() =>
      doctor({ ...SELECT, fetch: github.fetch, json: true }),
    );

    const findings = JSON.parse(output) as { problems: Array<{ kind: string }> };
    expect(findings.problems.map((finding) => finding.kind)).toContain('knowledge_unreachable');
    expect(exitCode).toBe(1);
  });
});

describe('an unreachable repository does not brick the profile', () => {
  test('the runtime still opens, so the command that undoes this can run', async () => {
    const root = await workspace();
    await use({ migrate: true });
    github.failEvery('/repos/my-org/my-notes', () => new Response(null, { status: 401 }));

    // Everything a person would reach for next: find out what is wrong, and
    // put things back. Both open a runtime, and both used to die on the token.
    await run(() => doctor({ ...SELECT, fetch: github.fetch }));
    await expect(
      knowledgeUse('local', { ...SELECT, fetch: github.fetch, migrate: false, yes: true }),
    ).resolves.toBeUndefined();

    expect(await readProfile(root)).not.toContain('knowledge:');
  });
});

describe('removing a profile does not reach into the repository', () => {
  test('the plan says the repository survives, and lists nothing in it', async () => {
    await workspace();
    await use({ migrate: true });

    // `--dry-run`, so this asserts what the operator is shown *before* they
    // confirm — which is where a surprise of this size has to be said.
    const { output } = await run(() => removeProfile('personal', { ...SELECT, dryRun: true, yes: true }));

    expect(output).toContain('my-org/my-notes');
    expect(output).toContain('survive this removal');
    // The routing that points memory at a repository lives in `openRuntime`;
    // this command opens the target's declared storage, so it cannot see one.
    expect(output).not.toContain('memory/main/a-note.md');
    expect(output).not.toContain('entities/main/jan-bakker.md');
    expect(github.files()).toEqual({
      'memory/main/a-note.md': ENTRY,
      'skills/triage/SKILL.md': SKILL,
      'entities/main/jan-bakker.md': ENTITY,
      'entities/main/_index.json': '{"v":1}',
    });
  });
});
