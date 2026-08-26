import { afterAll, describe, expect, test } from 'bun:test';
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

  test('declares every target it was given, in the order given', async () => {
    // The reported bug: `--target` was accepted and dropped, and the template
    // could only ever emit `local` — so the command reported success and made a
    // profile that could not reach the deployment it had just been told about.
    await workspace();

    const created = await createProfile('personal', { targets: ['local'] });
    const text = await readFile(created.path, 'utf8');

    expect(created.targets).toEqual(['local']);
    expect(text).toContain('  local:');
    expect(text).toContain('./data/personal/credentials.enc');
  });

  test('writes no default_target, because nothing reads one', async () => {
    await workspace();

    const created = await createProfile('personal', { targets: ['local'] });

    expect(await readFile(created.path, 'utf8')).not.toContain('default_target');
  });

  test('refuses a target no sibling declares rather than inventing one', async () => {
    // The one place guessing is actively harmful. `deploy`'s survey proposes a
    // *fresh* project id, which is right for a first deploy and exactly wrong
    // here: pressing return would build a second, separate deployment instead
    // of adding this profile to the one that already exists.
    await workspace();
    await createProfile('personal', { targets: ['local'] });

    await expect(
      createProfile('work', { targets: ['local', 'cloud'], nonInteractive: true }),
    ).rejects.toThrow(/No profile in this workspace declares a target called "cloud"/);
  });

  test('and leaves nothing behind when it refuses', async () => {
    // Everything that can fail happens before the first write, so a refusal
    // leaves the workspace as it was rather than half a profile behind.
    const root = await workspace();
    await createProfile('personal', { targets: ['local'] });

    await createProfile('work', { targets: ['cloud'], nonInteractive: true }).catch(() => {});

    expect(existsSync(join(root, 'profiles', 'work.yaml'))).toBe(false);
  });

  test('copies a sibling’s adapters, with a service name of its own', async () => {
    const root = await workspace();
    await createProfile('personal', { targets: ['local'] });
    await writeFile(
      join(root, 'profiles', 'personal.yaml'),
      (await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8')).replace(
        '    storage: { adapter: filesystem, path: ./data/personal }\n',
        '    storage: { adapter: filesystem, path: ./data/personal }\n' +
          '  cloud:\n' +
          '    credentials: { adapter: gcp-secret-manager, project: my-project }\n' +
          '    storage: { adapter: gcs, bucket: your-bucket }\n' +
          '    vault: { adapter: secret }\n' +
          '    deploy: { platform: cloudrun, project: my-project, region: europe-west1, service: my-service, access: public }\n',
      ),
    );

    const created = await createProfile('work', {
      targets: ['local', 'cloud'],
      nonInteractive: true,
    });
    const text = await readFile(created.path, 'utf8');

    expect(created.copiedFrom).toEqual({ cloud: 'personal' });
    expect(text).toContain('project: my-project');
    expect(text).toContain('bucket: your-bucket');
    // The one field that must differ: two profiles in one project need two
    // services, which is what makes them separately deployable.
    expect(text).toContain('service: lanes-link-work-mcp');
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

    const listing = await readProfiles();

    expect(listing.root).toBe(root);
    expect(listing.profiles.map((profile) => profile.name).sort()).toEqual(['personal', 'work']);
    expect(listing.profiles[0]?.path).toContain(join('profiles'));
  });

  test('an empty workspace is a listing, not a failure', async () => {
    await workspace();

    expect(await readProfiles()).toMatchObject({ default: undefined, profiles: [] });
  });
});

describe('profile list --json', () => {
  test('puts nothing but JSON on stdout', async () => {
    await workspace();
    await createProfile('personal', { targets: ['local'] });

    const written = await captureStdout(() => profileList({ json: true }));

    // The assertion is the parse: a resolution line, a heading, or a table row
    // in front of this would throw here and nowhere else.
    const parsed = JSON.parse(written) as { profiles: { name: string }[] };
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['personal']);
  });

  test('an empty workspace still emits a document rather than prose', async () => {
    await workspace();

    const written = await captureStdout(() => profileList({ json: true }));

    expect(JSON.parse(written)).toMatchObject({ profiles: [] });
  });
});
