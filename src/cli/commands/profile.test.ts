import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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

    const first = await createProfile('personal', {});
    const second = await createProfile('work', {});

    expect(first.port).toBe(7337);
    expect(second.port).toBe(7338);
  });

  test('the first profile becomes the default without being asked', async () => {
    await workspace();

    const first = await createProfile('personal', {});
    const second = await createProfile('work', {});

    // Not merely a convenience: `resolveSelection` refuses to pick a profile on
    // its own, so a workspace whose only profile is not the default makes every
    // subsequent command fail until `--profile` is passed.
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
  });

  test('refuses to overwrite a profile that already exists', async () => {
    await workspace();
    await createProfile('personal', {});

    await expect(createProfile('personal', {})).rejects.toThrow(/already exists/);
  });
});

describe('readProfiles', () => {
  test('reports the root, the default, and a path per profile', async () => {
    const root = await workspace();
    await createProfile('personal', {});
    await createProfile('work', { default: true });

    const listing = await readProfiles();

    expect(listing.root).toBe(root);
    expect(listing.default).toBe('work');
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
    await createProfile('personal', {});

    const written = await captureStdout(() => profileList({ json: true }));

    // The assertion is the parse: a resolution line, a heading, or a table row
    // in front of this would throw here and nowhere else.
    const parsed = JSON.parse(written) as { default: string; profiles: { name: string }[] };
    expect(parsed.default).toBe('personal');
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['personal']);
  });

  test('an empty workspace still emits a document rather than prose', async () => {
    await workspace();

    const written = await captureStdout(() => profileList({ json: true }));

    expect(JSON.parse(written)).toMatchObject({ profiles: [] });
  });
});
