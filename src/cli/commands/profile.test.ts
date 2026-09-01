import { afterAll, describe, expect, test } from 'bun:test';
import { workspaceYaml } from '#profile/testing.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit } from '../output.ts';
import { createProfile, profileList, readProfiles } from './profile.ts';

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
  await writeFile(join(root, 'lanes-link.yaml'), workspaceYaml(['local']));
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
    expect(text).toContain('contract: 3');
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
    expect(existsSync(join(root, 'profiles', 'work.yaml'))).toBe(false);
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

    expect(existsSync(join(root, 'lanes-link.yaml'))).toBe(true);
    expect(await readFile(join(root, 'lanes-link.yaml'), 'utf8')).toContain('  local:');
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
