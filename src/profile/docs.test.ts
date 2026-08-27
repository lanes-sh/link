import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { workspaceSchema } from './schema.ts';
import { installRoot } from './workspace.ts';
import { parseConfig } from './load.ts';
import { parseManifest } from '#providers/custom/index.ts';

/**
 * The config examples in the docs must actually parse.
 *
 * They had all drifted: `configuration.md` still showed a `providers` block and
 * per-connection policy rules, and `init.md` used `secrets:` for a key renamed
 * to `credentials:` and declared `auth:` twice. Documentation that no longer
 * describes the schema is worse than none — someone copies it, gets a
 * validation error naming a path they did not write, and concludes the tool is
 * broken.
 *
 * Checking them here rather than by eye means the next schema change either
 * updates the docs or fails.
 */

const ROOT = installRoot(import.meta.dir);

/**
 * Every fenced YAML block that is a whole document, split by which kind.
 *
 * Both declare a contract, which is what tells a complete document from an
 * excerpt illustrating one block. What tells the two apart is `instance:` — a
 * profile has one and a workspace file does not. That distinction only started
 * mattering under ADR-052, when the docs gained worked examples of a workspace
 * registry alongside the profile ones.
 */
async function documentExamples(
  relative: string,
): Promise<{ profiles: string[]; workspaces: string[] }> {
  const text = await readFile(join(ROOT, relative), 'utf8');
  const profiles: string[] = [];
  const workspaces: string[] = [];

  const fence = /```yaml\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1] ?? '';
    if (!/^contract:\s*\d/m.test(body)) continue;
    if (/^instance:/m.test(body)) profiles.push(body);
    else workspaces.push(body);
  }

  return { profiles, workspaces };
}

describe('documented config examples parse', () => {
  test.each([
    'docs/detailed/configuration.md',
    'docs/detailed/init.md',
    'docs/detailed/deployment-cloudrun.md',
  ])('%s', async (relative) => {
    const { profiles, workspaces } = await documentExamples(relative);
    expect(profiles.length).toBeGreaterThan(0);

    for (const example of profiles) {
      expect(() => parseConfig(example, relative)).not.toThrow();
    }

    // Validated too, and against the schema that governs them. A workspace
    // example that does not parse is exactly as broken as a profile one, and
    // before ADR-052 there were none to catch.
    for (const example of workspaces) {
      expect(() => workspaceSchema.parse(parseYaml(example)), relative).not.toThrow();
    }
  });
});

/** Every fenced YAML block that looks like a whole manifest. */
async function manifestExamples(relative: string): Promise<string[]> {
  const text = await readFile(join(ROOT, relative), 'utf8');
  const blocks: string[] = [];

  for (const match of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    const body = match[1] ?? '';
    // A manifest declares an id and a connector; anything else is an excerpt.
    if (/^id:\s*\S/m.test(body) && /^connector:/m.test(body)) blocks.push(body);
  }

  return blocks;
}

describe('documented provider manifests parse', () => {
  /**
   * The same lesson as above, applied where the copy-paste actually happens. The
   * custom-provider page is the one someone follows verbatim, and its example
   * silently could not connect until this milestone — so it is worth having a
   * test rather than a promise.
   *
   * The coverage page is here for a sharper version of the same reason: its
   * examples are one per open row of a matrix, which means they are precisely the
   * combinations no built-in exercises. A page that claims a cell works is worth
   * less than nothing if its example for that cell does not parse.
   */
  const pages = ['docs/detailed/creating-a-provider.md', 'docs/detailed/connectivity-coverage.md'];

  test.each(pages)('%s', async (page: string) => {
    const examples = await manifestExamples(page);
    // Per file, not across them: the guard is against a page whose fences drift
    // out of the selector and then passes by not looking.
    expect(examples.length).toBeGreaterThan(3);

    for (const example of examples) {
      expect(() => parseManifest(example, page)).not.toThrow();
    }
  });
});

/**
 * That an ADR's number means one decision.
 *
 * Three files claimed ADR-040 at once, two of them named `039-`, and one of
 * those was in no index at all. Nothing caught it because nothing looked: the
 * number lives in three places — the filename, the heading, and the row in
 * `README.md` — and parallel branches each picked the next free one.
 *
 * A reference like "(ADR-040)" in a comment is then not merely stale, it is
 * ambiguous, and the reader has no way to tell which of the three was meant.
 */
describe('ADR numbering', () => {
  const ADR = join(import.meta.dir, '..', '..', 'docs', 'detailed', 'adr');

  async function decisions(): Promise<{ file: string; number: string; heading: string }[]> {
    const names = (await readdir(ADR)).filter((name) => /^\d{3}-.*\.md$/.test(name)).sort();

    return Promise.all(
      names.map(async (file) => {
        const first = (await readFile(join(ADR, file), 'utf8')).split('\n')[0] ?? '';
        return {
          file,
          number: file.slice(0, 3),
          heading: /^#\s*ADR-(\d{3}):/.exec(first)?.[1] ?? '',
        };
      }),
    );
  }

  test('no two decisions share a number', async () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];

    for (const { file, number } of await decisions()) {
      const first = seen.get(number);
      if (first) clashes.push(`${number}: ${first} and ${file}`);
      else seen.set(number, file);
    }

    expect(clashes).toEqual([]);
  });

  test('the heading agrees with the filename', async () => {
    const disagree = (await decisions())
      .filter((one) => one.heading !== one.number)
      .map((one) => `${one.file} is headed ADR-${one.heading || '???'}`);

    expect(disagree).toEqual([]);
  });

  test('every decision is in the index, and every index row resolves', async () => {
    const readme = await readFile(join(ADR, 'README.md'), 'utf8');
    const linked = new Set([...readme.matchAll(/\]\((\d{3}-[a-z0-9-]+\.md)\)/g)].map((m) => m[1]!));
    const files = (await decisions()).map((one) => one.file);

    expect(files.filter((file) => !linked.has(file))).toEqual([]);
    expect([...linked].filter((file) => !files.includes(file))).toEqual([]);
  });
});
