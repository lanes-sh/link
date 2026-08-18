import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSETS, assetState, installAsset, readAsset, sourcePath } from './assets.ts';

/**
 * Installing the documents into a client.
 *
 * The property under test is the one the command promises: running `mcp add`
 * again gives you the current document, and running it twice in a row changes
 * nothing the second time. `config-edit.test.ts` asserts the same shape for the
 * config writer, and for the same reason — an "idempotent" writer that rewrites
 * identical bytes is only idempotent in its output, not on disk.
 */

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-assets-'));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SKILL = ASSETS.find((asset) => asset.kind === 'skill')!;
const AGENT = ASSETS.find((asset) => asset.kind === 'agent')!;

describe('writing one in', () => {
  test('creates the directory it needs', async () => {
    // Neither ~/.claude/skills nor ~/.claude/agents necessarily exists — a
    // machine that has never installed one has neither.
    const root = await scratch();
    const path = join(root, 'skills', 'lanes-link', 'SKILL.md');

    expect(await installAsset({ asset: SKILL, path }, 'body')).toBe('installed');
    expect(await readFile(path, 'utf8')).toBe('body');
  });

  test('a second identical run reports unchanged and does not rewrite', async () => {
    const root = await scratch();
    const path = join(root, 'skills', 'lanes-link', 'SKILL.md');
    const body = await readAsset(SKILL);

    expect(await installAsset({ asset: SKILL, path }, body)).toBe('installed');

    const first = await Bun.file(path).stat();
    expect(await installAsset({ asset: SKILL, path }, body)).toBe('unchanged');

    // Not merely "same bytes": the file was not touched at all. A harness
    // watching its skills directory would otherwise reload on every mcp add.
    expect((await Bun.file(path).stat()).mtimeMs).toBe(first.mtimeMs);
  });

  test('a newer document replaces an older one, and says so', async () => {
    const root = await scratch();
    const path = join(root, 'skills', 'lanes-link', 'SKILL.md');

    await installAsset({ asset: SKILL, path }, 'the old text');
    expect(await installAsset({ asset: SKILL, path }, 'the new text')).toBe('updated');
    expect(await readFile(path, 'utf8')).toBe('the new text');
  });

  test('a hand-edited copy is restored, because the directory is ours', async () => {
    // `lanes-link/` is named after this project, so overwriting is not a
    // surprise. Someone who wants their own version writes their own skill.
    const root = await scratch();
    const path = join(root, 'skills', 'lanes-link', 'SKILL.md');
    const body = await readAsset(SKILL);

    await mkdir(join(root, 'skills', 'lanes-link'), { recursive: true });
    await writeFile(path, 'something a person typed');

    expect(await installAsset({ asset: SKILL, path }, body)).toBe('updated');
    expect(await readFile(path, 'utf8')).toBe(body);
  });
});

describe('reporting what is there', () => {
  test('distinguishes missing, stale, and current', async () => {
    const root = await scratch();
    const path = join(root, 'skills', 'lanes-link', 'SKILL.md');
    const plan = { asset: SKILL, path };

    expect(await assetState(plan, 'body')).toBe('missing');

    await installAsset(plan, 'body');
    expect(await assetState(plan, 'body')).toBe('current');
    expect(await assetState(plan, 'a newer body')).toBe('stale');
  });

  test('checking does not write', async () => {
    const root = await scratch();
    const path = join(root, 'skills', 'lanes-link', 'SKILL.md');

    expect(await assetState({ asset: SKILL, path }, 'body')).toBe('missing');
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe('the bundled documents', () => {
  test('both are present in this checkout', async () => {
    for (const asset of ASSETS) {
      expect(await Bun.file(sourcePath(asset)).exists()).toBe(true);
    }
  });

  test('a missing one names where it should have been', async () => {
    // The case is real: `.dockerignore` keeps `instructions/` out of the image,
    // so a CLI run inside a container hits exactly this.
    const absent = { ...SKILL, source: 'skills/not-a-skill/SKILL.md' };

    expect(readAsset(absent)).rejects.toThrow('instructions/skills/not-a-skill/SKILL.md');
  });

  test('each carries the frontmatter its harness reads', async () => {
    for (const asset of [SKILL, AGENT]) {
      const body = await readAsset(asset);

      expect(body).toStartWith('---\n');
      expect(body).toMatch(/^name: \S+$/m);
      expect(body).toMatch(/^description: \S/m);
    }
  });
});
