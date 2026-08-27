import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '#profile';
import { loadProfileProviders, parseManifest } from '#providers/custom/index.ts';
import { deriveDeclaration, deriveManifest } from './derive.ts';
import type { CustomAnswers } from './spec.ts';
import {
  checkOpenapiReachable,
  manifestDiff,
  manifestPath,
  readExistingManifest,
  renderManifest,
  writeManifest,
} from './write.ts';

/**
 * That the file this command writes is one the loader reads.
 *
 * Asserted against `loadProfileProviders` rather than against this file's own
 * idea of the path, because "wrote a manifest" and "declared a provider" are
 * only the same claim if the two agree about where manifests live — and the one
 * message that used to tell an operator that named the wrong directory.
 */

const roots: string[] = [];
const PROFILE = 'personal';

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-declare-'));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const answers = (values: Record<string, string | readonly string[]> = {}): CustomAnswers => ({
  id: 'thing',
  name: 'Thing',
  connector: 'http',
  auth: 'bearer',
  values: {
    'base-url': 'https://api.example.com/v1',
    openapi: 'https://api.example.com/openapi.json',
    ...values,
  },
});

describe('the manifest lands where the loader looks', () => {
  test('and comes back as the provider that was declared', async () => {
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');

    await writeManifest(path, renderManifest(deriveDeclaration(answers())));

    const loaded = await loadProfileProviders(root, PROFILE);
    expect(loaded.map((entry) => entry.manifest.id)).toEqual(['thing']);
    expect(loaded[0]?.manifest.auth).toMatchObject({ kind: 'bearer' });
  });

  test('creating the directory, which nothing else does', async () => {
    // `layout.providers` is only ever read, listed and deleted — no command
    // created it, so the first declaration in a profile has to.
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');

    await writeManifest(path, 'id: thing\n');

    expect((await stat(join(root, layout.providers(PROFILE)))).isDirectory()).toBe(true);
  });

  test('readable only by its owner, like every other file here', async () => {
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');

    await writeManifest(path, 'id: thing\n');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('and nothing half-written survives a crash', async () => {
    // The temp file is `.tmp`, which the filesystem blob store skips when it
    // lists — so a crash between write and rename cannot leave a file the
    // loader tries to parse, which would break every command for this profile.
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    await mkdir(join(root, layout.providers(PROFILE)), { recursive: true });
    await writeFile(`${path}.tmp`, 'id: broken');

    await expect(loadProfileProviders(root, PROFILE)).resolves.toEqual([]);
  });
});

describe('a second run against the file already there', () => {
  const derived = () => deriveManifest(answers());

  test('the same answers are no difference at all', async () => {
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    await writeManifest(path, renderManifest(deriveDeclaration(answers())));

    const existing = await readExistingManifest(path);
    expect(manifestDiff(derived(), existing!)).toEqual([]);
  });

  test('and neither is something the operator added afterwards', async () => {
    // The file is theirs the moment it exists. `redact` and `hints` are exactly
    // what somebody adds once they have seen the tool list, and a re-run reading
    // them as drift would refuse to proceed for no reason.
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    await writeManifest(
      path,
      `${renderManifest(deriveDeclaration(answers()))}\nredact:\n  list_things: [id]\nhints:\n  list_things: Prefer this.\n`,
    );

    const existing = await readExistingManifest(path);
    expect(manifestDiff(derived(), existing!)).toEqual([]);
  });

  test('a changed value is named, with both sides', async () => {
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    await writeManifest(
      path,
      renderManifest(deriveDeclaration(answers({ 'base-url': 'https://api.example.com/v2' }))),
    );

    const existing = await readExistingManifest(path);
    expect(manifestDiff(derived(), existing!)).toEqual([
      'connector.base_url: https://api.example.com/v2 → https://api.example.com/v1',
    ]);
  });

  test('a dropped flag is a difference too, not silence', async () => {
    // Compared in both directions on purpose: answering "unchanged" here would
    // leave an operation filter in place that the operator has just stopped
    // asking for.
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    await writeManifest(
      path,
      renderManifest(deriveDeclaration(answers({ operations: ['*Account*'] }))),
    );

    const existing = await readExistingManifest(path);
    expect(manifestDiff(derived(), existing!)).not.toEqual([]);
  });

  test('a relative spec path compares as written, not as resolved', async () => {
    // `readExistingManifest` uses `parseManifest` rather than the loader's file
    // variant for exactly this: resolving one side and not the other makes every
    // re-run read as a change.
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    const relative = answers({ openapi: './thing.json' });
    await writeManifest(path, renderManifest(deriveDeclaration(relative)));

    const existing = await readExistingManifest(path);
    expect(manifestDiff(deriveManifest(relative), existing!)).toEqual([]);
  });

  test('nothing there is nothing to compare', async () => {
    const root = await workspace();
    expect(await readExistingManifest(manifestPath(root, PROFILE, 'absent'))).toBeNull();
  });
});

describe('an OpenAPI document named as a path', () => {
  test('a URL is taken on trust and not fetched', async () => {
    const root = await workspace();
    await expect(
      checkOpenapiReachable('https://api.example.com/openapi.json', root, PROFILE),
    ).resolves.toBeUndefined();
  });

  test('one beside the manifest is found', async () => {
    const root = await workspace();
    const directory = join(root, layout.providers(PROFILE));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'thing.json'), '{}');

    await expect(checkOpenapiReachable('./thing.json', root, PROFILE)).resolves.toBeUndefined();
  });

  test('a missing one is refused before anything is written', async () => {
    // Left alone this surfaces inside the OpenAPI generator, after the manifest
    // is on disk — and `openRuntime` swallows a discovery failure so startup
    // survives, leaving a provider with no capabilities and nothing saying why.
    const root = await workspace();

    await expect(checkOpenapiReachable('./thing.json', root, PROFILE)).rejects.toThrow(
      /No OpenAPI document at/,
    );
  });

  test('and one in the working directory instead says so, naming both', async () => {
    // Everyone types `./spec.json` meaning "next to where I am". A manifest
    // resolves it against the manifest, which is right and is not what they
    // meant, so the refusal has to say both things.
    const root = await workspace();
    const here = join(process.cwd(), 'connect-custom-spec-fixture.json');
    await writeFile(here, '{}');

    try {
      await expect(
        checkOpenapiReachable('./connect-custom-spec-fixture.json', root, PROFILE),
      ).rejects.toThrow(/It does exist at/);
    } finally {
      await rm(here, { force: true });
    }
  });
});

describe('the file a reader opens', () => {
  test('says what wrote it and that editing it is expected', async () => {
    const root = await workspace();
    const path = manifestPath(root, PROFILE, 'thing');
    await writeManifest(path, renderManifest(deriveDeclaration(answers())));

    const text = await readFile(path, 'utf8');
    expect(text).toMatch(/^# Written by `lanes link connect custom`/);
    expect(text).toMatch(/re-reads this file every time/);
    // And it is still a manifest after the comment.
    expect(() => parseManifest(text, path)).not.toThrow();
  });
});
