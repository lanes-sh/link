import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A provider hands back a `resource_link` only for a file.
 *
 * A client may treat a link in a tool result as a file to fetch, and ChatGPT
 * does: it stops to ask the owner whether it may "materialise" the link, then
 * reads the address and keeps what comes back as a file. Memory, tasks and
 * entities each linked the record a call had just written or found, so saving a
 * note asked for that approval every time.
 *
 * A record is named by its id in the text, which is what its provider's `get`
 * takes. A link is for something that is a file.
 *
 * Read off the source rather than by calling every tool, because the failure is
 * a handler written the old way and there is no list of handlers to call. The
 * list is checked in both directions, so it cannot outlive the provider it
 * names.
 */
const LINKS_A_FILE = ['assets/provider.ts'];

/** Reads links back out of results for the provider tests, and hands none back. */
const TEST_HARNESS = 'harness.ts';

test('only a provider whose resources are files hands back a resource_link', async () => {
  const linking: string[] = [];

  for (const path of await readdir(import.meta.dir, { recursive: true })) {
    if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path === TEST_HARNESS) continue;

    const source = await readFile(join(import.meta.dir, path), 'utf8');
    if (/type:\s*['"]resource_link['"]/.test(source)) linking.push(path);
  }

  expect(linking.sort()).toEqual(LINKS_A_FILE);
});
