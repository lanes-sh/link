import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** Every fenced YAML block that looks like a whole profile, not a fragment. */
async function profileExamples(relative: string): Promise<string[]> {
  const text = await readFile(join(ROOT, relative), 'utf8');
  const blocks: string[] = [];

  const fence = /```yaml\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1] ?? '';
    // A complete profile declares the contract; anything else is an excerpt
    // illustrating one block, which cannot be parsed on its own.
    if (/^contract:\s*\d/m.test(body)) blocks.push(body);
  }

  return blocks;
}

describe('documented config examples parse', () => {
  test.each([
    'docs/detailed/configuration.md',
    'docs/detailed/init.md',
    'docs/detailed/deployment-cloudrun.md',
  ])('%s', async (relative) => {
    const examples = await profileExamples(relative);
    expect(examples.length).toBeGreaterThan(0);

    for (const example of examples) {
      expect(() => parseConfig(example, relative)).not.toThrow();
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
  // The same lesson as above, applied where the copy-paste actually happens. The
  // custom-provider page is the one someone follows verbatim, and its example
  // silently could not connect until this milestone — so it is worth having a
  // test rather than a promise.
  test('docs/detailed/creating-a-provider.md', async () => {
    const examples = await manifestExamples('docs/detailed/creating-a-provider.md');
    expect(examples.length).toBeGreaterThan(3);

    for (const example of examples) {
      expect(() => parseManifest(example, 'docs/detailed/creating-a-provider.md')).not.toThrow();
    }
  });
});
