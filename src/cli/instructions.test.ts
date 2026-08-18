import { describe, expect, test } from 'bun:test';
import { ASSETS, readAsset } from './commands/mcp/assets.ts';
import { PROGRAM, USAGE } from './usage.ts';

/**
 * The documents we install into someone's agent must describe this CLI.
 *
 * Same lesson as `src/profile/docs.test.ts`, applied where the copy-paste is
 * done by a language model rather than a person: a skill that names a command
 * which does not exist is worse than no skill, because the agent will run it
 * confidently and report the failure as the user's problem. Checking here means
 * the next rename either updates these documents or fails.
 */

/** Every `lanes link <something>` a document tells an agent to run. */
function commandsNamedIn(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(new RegExp(`${PROGRAM} ([a-z]+(?: [a-z]+)?)`, 'g'))) {
    found.add(match[1]!);
  }

  return [...found].sort();
}

/** The command paths `USAGE` documents, as `"mcp add"` and `"start"`. */
const documented = new Set(
  USAGE.split('\n')
    .map((line) => line.trim())
    // The title line spells PROGRAM in bold, so it carries ANSI codes and does
    // not match — which is right: it is a heading, not a command.
    .filter((line) => line.startsWith(PROGRAM))
    .flatMap((line) => {
      const words = line.slice(PROGRAM.length).trim().split(/\s+/);
      const first = words[0];
      const second = words[1];
      if (!first || first.startsWith('-') || first.startsWith('<')) return [];
      return second && /^[a-z]+$/.test(second) ? [first, `${first} ${second}`] : [first];
    }),
);

describe.each(ASSETS.map((asset) => [asset.label, asset] as const))('the bundled %s', (_label, asset) => {
  test('names only commands this CLI actually has', async () => {
    const named = commandsNamedIn(await readAsset(asset));
    const unknown = named.filter((command) => {
      // "mcp add" is documented; "mcp" alone is reached via "mcp add".
      const [head] = command.split(' ');
      return !documented.has(command) && !documented.has(head!);
    });

    expect(unknown).toEqual([]);
  });

  test('names at least one, or the check above passed on an empty list', async () => {
    expect(commandsNamedIn(await readAsset(asset)).length).toBeGreaterThan(0);
  });

  test('never tells an agent to print a token', async () => {
    const lines = (await readAsset(asset)).split('\n');

    // `token show --raw` inside a `$(…)` is the correct form and appears in the
    // skill deliberately. `--show` prints the value into the transcript, which
    // is the mistake the skill exists to prevent — so it may appear as the
    // labelled wrong half of a comparison, and nowhere else.
    for (const [index, line] of lines.entries()) {
      if (!line.includes('token show --show')) continue;
      expect(`${lines[index - 1] ?? ''}\n${line}`).toContain('WRONG');
    }
  });
});

describe('the skill and the scout agree', () => {
  test('both state the profile rule, since either may be the only one loaded', async () => {
    for (const asset of ASSETS) {
      expect(await readAsset(asset)).toContain('separate');
    }
  });
});
