import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What a command tells the reader to go and look at.
 *
 * The registry file was renamed `lanes-link.yaml` → `workspaces.yaml` in
 * contract 4, and the rename left messages behind pointing at a file that no
 * longer exists — including one that cites ADR-061, the decision that renamed
 * it. Nothing failed, because a wrong sentence compiles.
 *
 * This is the check that stops the next rename doing the same. Prose *about*
 * the old name is fine, in a comment or in a sentence that says it is the old
 * name; what is refused is a message sending someone to open it.
 */

const RETIRED = 'lanes-link.yaml';

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** A comment line, where the old name is history rather than instruction. */
const isProse = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
};

/** A sentence that introduces it as retired, which is the one honest use. */
const namesItAsOld = (line: string): boolean => /old name|retired|renamed|used to/i.test(line);

describe('a message never sends the reader to a file that was renamed', () => {
  test(`no command tells anyone to look in ${RETIRED}`, async () => {
    const offenders: string[] = [];

    for (const path of await sources(join(import.meta.dir, 'commands'))) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (!line.includes(RETIRED)) return;
        if (isProse(line) || namesItAsOld(line)) return;
        offenders.push(`${path.slice(path.indexOf('src/'))}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
