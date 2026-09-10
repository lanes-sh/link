import { afterAll, describe, expect, test } from 'bun:test';
import { workspaceYaml } from '#profile/testing.ts';
import { assertGrantsResolve, loadProfileConfig, readConnections } from '#profile';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit } from '../output.ts';
import { createProfile, profileAdd, profileList, publishedAfterCreate, readProfiles } from './profile.ts';

/**
 * `lanes link profile`, and the `--json` guard every machine-readable command
 * depends on.
 *
 * The property under test is not the wording. It is that `--json` puts *only* a
 * JSON document on stdout: every command prints the resolved profile and target
 * before acting, deliberately, and that line in front of a JSON document is the
 * difference between a parser and a crash. `outputs` got it right by hand and
 * nothing held it there, so `emit` is now the one place it can be got wrong.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-profile-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  // The registry, because a target is declared by the workspace now and every
  // command below names one (ADR-052). `createProfile` seeds this itself on a
  // bare directory, which the seeding test covers.
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Everything written to stdout while `body` runs. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
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

  return captured;
}

describe('emit', () => {
  test('prints JSON and does not run the human rendering', () => {
    let rendered = false;

    const written = emitToString(() => emit(true, { ok: true }, () => void (rendered = true)));

    expect(JSON.parse(written)).toEqual({ ok: true });
    expect(rendered).toBe(false);
  });

  test('runs the human rendering when --json was not given', () => {
    let rendered = false;

    emit(undefined, { ok: true }, () => void (rendered = true));

    expect(rendered).toBe(true);
  });

  /** Synchronous stdout capture, for the non-async `emit` cases above. */
  function emitToString(body: () => void): string {
    const original = process.stdout.write.bind(process.stdout);
    let captured = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: string): boolean => {
      captured += chunk;
      return true;
    };
    try {
      body();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = original;
    }
    return captured;
  }
});

describe('an unmigrated workspace is refused, not shadowed', () => {
  /**
   * `resolveWorkspaceRoot` and `listProfiles` both accept the contract-3 shape,
   * deliberately — a workspace that needs migrating has to be findable by the
   * command that migrates it. `createProfile` tested only the new names, so it
   * wrote files that hid the operator's real ones: a registry beside
   * `lanes-link.yaml`, which `readWorkspace` then preferred, taking every
   * declared target and deployment record with it and leaving no route back,
   * because `renameRegistry` returns early once the new file exists.
   */
  test('a registry under the old name stops it writing a second one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-c3-'));
    roots.push(root);
    process.env['LANES_LINK_HOME'] = root;
    await writeFile(join(root, 'lanes-link.yaml'), workspaceYaml(['local', 'cloud']));

    await expect(createProfile('work', { targets: ['local'] })).rejects.toThrow(
      /contract 3[\s\S]*doctor --fix/,
    );
    expect(existsSync(join(root, 'workspaces.yaml'))).toBe(false);
  });

  test('a profile under the old name is not written over', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-c3-'));
    roots.push(root);
    process.env['LANES_LINK_HOME'] = root;
    await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal.yaml'), 'contract: 3\n');

    // `listProfiles` already sees it, so a fresh template beside it is one name
    // with two files — and the empty one is what opens.
    await expect(createProfile('personal', { targets: ['local'] })).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('createProfile', () => {
  test('gives each profile its own port, so two can serve at once', async () => {
    await workspace();

    const first = await createProfile('personal', { targets: ['local'] });
    const second = await createProfile('work', { targets: ['local'] });

    expect(first.port).toBe(7337);
    expect(second.port).toBe(7338);
  });

  test('writes a profile that declares no target at all', async () => {
    // The reported bug was the opposite one: `--target` was accepted and
    // dropped, and the template could only ever emit `local`. The flag is now
    // load-bearing in a different way — it decides which *workspace* the file is
    // written into, and the file itself says nothing about where it runs
    // (ADR-052).
    await workspace();

    const created = await createProfile('personal', { targets: ['local'] });
    const text = await readFile(created.path, 'utf8');

    expect(created.targets).toEqual(['local']);
    expect(text).toContain('contract: 5');
    expect(text).not.toContain('targets:');
    expect(text).not.toContain('credentials:');
  });

  test('writes no default_target, because nothing reads one', async () => {
    await workspace();

    const created = await createProfile('personal', { targets: ['local'] });

    expect(await readFile(created.path, 'utf8')).not.toContain('default_target');
  });

  test('refuses a target the workspace does not declare', async () => {
    // It used to copy a sibling profile's adapters, or ask. There is nothing to
    // copy and nothing to ask about: the target is declared by the workspace, so
    // one that is not there is a name that resolves to nowhere.
    const root = await workspace();
    await createProfile('personal', { targets: ['local'] });

    await expect(createProfile('work', { targets: ['cloud'] })).rejects.toThrow(/cloud/);
    expect(existsSync(join(root, 'profiles', 'work', 'profile.yaml'))).toBe(false);
  });

  test('creates the workspace file first, so an empty directory can be seeded', async () => {
    // `profile add <name> --workspace local` on nothing at all is how a workspace
    // comes into existence, and the target it names is declared *by* the file it
    // is about to write. Resolving before writing would be resolving a target
    // nothing has declared yet.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-seed-'));
    roots.push(root);
    process.env['LANES_LINK_HOME'] = root;

    const created = await createProfile('personal', { targets: ['local'] });

    expect(existsSync(join(root, 'workspaces.yaml'))).toBe(true);
    expect(await readFile(join(root, 'workspaces.yaml'), 'utf8')).toContain('  local:');
    expect(existsSync(created.path)).toBe(true);
  });

  test('refuses to overwrite a profile that already exists', async () => {
    await workspace();
    await createProfile('personal', { targets: ['local'] });

    await expect(createProfile('personal', { targets: ['local'] })).rejects.toThrow(/already exists/);
  });
});

describe('readProfiles', () => {
  test('reports the root, the default, and a path per profile', async () => {
    const root = await workspace();
    await createProfile('personal', { targets: ['local'] });
    await createProfile('work', { targets: ['local'] });

    const listing = await readProfiles('local');

    expect(listing.root).toBe(root);
    expect(listing.profiles.map((profile) => profile.name).sort()).toEqual(['personal', 'work']);
    expect(listing.profiles[0]?.path).toContain(join('profiles'));
  });

  test('an empty workspace is a listing, not a failure', async () => {
    await workspace();

    expect(await readProfiles('local')).toMatchObject({ default: undefined, profiles: [] });
  });
});

describe('profile list --json', () => {
  test('puts nothing but JSON on stdout', async () => {
    await workspace();
    await createProfile('personal', { targets: ['local'] });

    const written = await captureStdout(() => profileList('local', { json: true }));

    // The assertion is the parse: a resolution line, a heading, or a table row
    // in front of this would throw here and nowhere else.
    const parsed = JSON.parse(written) as { profiles: { name: string }[] };
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['personal']);
  });

  test('an empty workspace still emits a document rather than prose', async () => {
    await workspace();

    const written = await captureStdout(() => profileList('local', { json: true }));

    expect(JSON.parse(written)).toMatchObject({ profiles: [] });
  });
});

/**
 * A new profile has to reach the endpoint that will serve it.
 *
 * `profile add` was the one config-writing command that wrote its file and told
 * nobody, while `connect`, `grant`, `members`, `policy`, `identity`, `relabel`
 * and `connection` all end on `publishProfileEdit`. On a deployed workspace
 * that made a profile durable and invisible: a running endpoint lists the
 * profiles at boot and at a reload and at no other time, so the bucket held it
 * and `/state` — and so the dashboard, and every client — did not, until the
 * revision happened to restart.
 *
 * These sit on `profileAdd` rather than `createProfile` deliberately. The split
 * between the two is what hid the gap in the first place: every existing test
 * here drives the data function, and the publish belongs to the wrapper.
 */
describe('a created profile is published to the endpoint that serves it', () => {
  test('a served edit says so, and says how a client picks it up', () => {
    const line = publishedAfterCreate({ served: true, tools: 26 });

    expect(line).toContain('Serving it now');
    expect(line).toContain('26 tools');
  });

  test('a deployed target reports even when nothing answered', () => {
    // The case this whole change exists for. The config is in the bucket, so
    // the next boot serves it — but the revision running *now* does not, and
    // silence is precisely what made that a surprise worth debugging.
    const line = publishedAfterCreate({
      served: false,
      published: 'gs://bucket-name',
      url: 'https://service.example.com/reload',
      reason: 'no endpoint answered',
    });

    expect(line).toContain('no endpoint answered');
    expect(line).toContain('when it next starts');
  });

  test('a workspace that publishes nowhere and answers nothing says nothing', () => {
    // `profile add` is the first command anybody runs. Reporting that an
    // endpoint could not be notified, as the first sentence this CLI prints,
    // describes an endpoint they have not set up yet — and nothing is holding a
    // stale view of a profile that did not exist a moment ago.
    expect(
      publishedAfterCreate({
        served: false,
        url: 'http://127.0.0.1:7337/reload',
        reason: 'no static token is issued in this workspace, so the endpoint cannot be notified',
      }),
    ).toBeUndefined();
  });

  test('a fresh workspace still creates the profile, and stays quiet about it', async () => {
    // The regression guard for the wrapping. `profile add` is the command that
    // may have *just written* the workspace it publishes to, so the credential
    // store the notify authenticates with can be opened before one exists — and
    // a creation that succeeded must never report failure.
    const root = join(await mkdtemp(join(tmpdir(), 'lanes-link-publish-')), 'workspace');
    roots.push(root);
    process.env['LANES_LINK_HOME'] = root;

    const printed = await captureStdout(async () => {
      await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });
    });

    const parsed = JSON.parse(printed) as { name: string; published?: string };
    expect(parsed.name).toBe('personal');
    expect(parsed.published).toBeUndefined();
    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);
  });

  test('adding a profile that is already there provisions it instead of refusing', async () => {
    // Why there is no second verb for this. What a deployed target needs doing
    // before it can serve a profile is the same work whether the profile was
    // written a moment ago or last month — so a command that only did it while
    // creating would leave every profile predating this change reachable by
    // nothing short of a full deploy. `add` is "make this profile usable here".
    //
    // Local here, so nothing reaches a cloud: `provisionProfiles` reports
    // `applicable: false` for a target that declares no deployment, which is the
    // same check that makes this unconditional elsewhere.
    const root = await workspace();
    await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });

    const printed = await captureStdout(async () => {
      await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });
    });

    const parsed = JSON.parse(printed) as { name: string; existed?: boolean; port: number };
    expect(parsed.name).toBe('personal');
    expect(parsed.existed).toBe(true);

    // Still not an overwrite: the port it reports is the one on disk, read back
    // rather than freshly assigned.
    expect(parsed.port).toBe(7337);
    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);
  });
});

/**
 * A new profile grants the connections this workspace holds.
 *
 * The template used to pair each owner-layer surface with a fixed id, which is
 * true only of a workspace the same template seeded. `connections.yaml` numbers
 * its rows in creation order, so a workspace whose owner layer arrived in a
 * different order holds `lanes_memory` somewhere other than `lan1` — and a
 * profile added to it named seven connections that were not there.
 *
 * What made that expensive to find is what happens next. `assertGrantsResolve`
 * refuses the profile at load, and `openReconciled` skips a profile it cannot
 * open rather than failing the endpoint for its siblings. So the profile was
 * written, refused and skipped: it listed under `profile list`, which reads the
 * directory, and appeared in nothing that reads config. On a deployed workspace
 * the only trace was one line in the endpoint's log.
 */
describe('the owner layer is granted by id, not by assumption', () => {
  /** A workspace whose owner layer is numbered in a different order. */
  async function shuffled(): Promise<string> {
    const root = await workspace();
    await writeFile(
      join(root, 'connections.yaml'),
      [
        'contract: 5',
        '',
        'connections:',
        '  - { id: lan1, provider: lanes_setup, account: Setup }',
        '  - { id: lan2, provider: lanes_memory, account: Memory }',
        '  - { id: lan3, provider: lanes_skills, account: Skills }',
        '  - { id: lan4, provider: lanes_tasks, account: Tasks }',
        '  - { id: lan5, provider: lanes_assets, account: Assets }',
        '  - { id: lan6, provider: lanes_vault, account: Vault }',
        '  - { id: lan7, provider: lanes_entities, account: Entities }',
        '',
        'oauth_apps: {}',
        'tokens: []',
        '',
      ].join('\n'),
    );
    return root;
  }

  test('every grant names a connection the workspace actually holds', async () => {
    const root = await shuffled();
    await createProfile('projects', { targets: ['local'] });

    const written = await readFile(join(root, 'profiles', 'projects', 'profile.yaml'), 'utf8');

    // The shuffled ids, not the template's. `lanes_memory` is lan2 here.
    expect(written).toContain('connection: lanes_memory.lan2');
    expect(written).toContain('connection: lanes_setup.lan1');
    expect(written).not.toContain('connection: lanes_memory.lan1');
  });

  test('the profile it writes actually loads', async () => {
    // The assertion that matters, because the grants resolving is only the
    // mechanism. `resolveSelection` plus a load is what the endpoint does, and
    // what silently skipped this profile before.
    const root = await shuffled();
    await createProfile('projects', { targets: ['local'] });

    const { config } = await loadProfileConfig(root, 'projects');
    const held = await readConnections(root);

    expect(config.grants.map((grant) => grant.connection)).toContain('lanes_memory.lan2');
    expect(() => assertGrantsResolve(config, held.connections)).not.toThrow();
  });

  test('a surface the workspace does not hold is left ungranted, not invented', async () => {
    // Inventing a ref produces a profile that never loads. Leaving it out
    // produces one that loads and is missing a surface, which `ensureOwnerLayer`
    // repairs on the next `start` by writing both halves.
    const root = await workspace();
    await writeFile(
      join(root, 'connections.yaml'),
      ['contract: 5', '', 'connections:', '  - { id: lan1, provider: lanes_memory, account: Memory }', '', 'oauth_apps: {}', 'tokens: []', ''].join('\n'),
    );

    await createProfile('sparse', { targets: ['local'] });

    // The parsed grants, not the file's text: the template's own header explains
    // the surfaces by name, so a substring search finds `lanes_vault.` in a
    // comment and says the grant is there.
    const { config } = await loadProfileConfig(root, 'sparse');
    const held = await readConnections(root);
    const granted = config.grants.map((grant) => grant.connection);

    expect(granted).toEqual(['lanes_memory.lan1']);
    expect(() => assertGrantsResolve(config, held.connections)).not.toThrow();
  });
});
