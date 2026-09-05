import { style } from './output.ts';
import { width } from './terminal.ts';
import { visibleWidth, wrap } from './typeset.ts';
import { SECTIONS, type Entry } from './usage-data.ts';

/**
 * The help text, and the name the CLI calls itself.
 *
 * `PROGRAM` is a constant rather than 59 string literals because it had been 59
 * string literals: the rename that produced `lanes link` meant editing the usage
 * text, every `Usage:` line, and every `Unknown:` line by hand, with no way to
 * tell from a green test suite whether one had been missed. The next rename
 * touches this line, and `argv.test.ts` holds the two to each other.
 *
 * **The text is data now, and the columns are computed.** It used to be one
 * template literal with the descriptions hand-aligned, which failed in the way
 * hand-alignment always does: descriptions started at column 40 in most of the
 * file, 33 in the `connect custom` block, and 41, 49 and 50 elsewhere. Worse,
 * `--non-interactive`'s description had come adrift from its command — two
 * lines indented to column 40, sitting four entries below the flag they
 * describe because `connect custom` was inserted between them, reading as part
 * of *its* description instead. Nothing could catch that, because nothing knew
 * the two belonged together. Now they are one object, and the pairing is not
 * something a person maintains by counting spaces.
 *
 * Rendered rather than stored, so `--help` fits the terminal it is asked on.
 * The longest line was 100 characters and 72 of 195 lines exceeded 80, so an
 * eighty-column terminal shredded a third of the help.
 */

/** How this CLI is invoked — the `link` area of the `lanes` command. */
export const PROGRAM = 'lanes link';

const BANNER =
  '— a self-hostable MCP gateway for all your connections, memory, tasks, files, and secrets';

const FOOTER = 'Every command prints the profile and target it is acting on, before it acts.';

/**
 * Where a description starts.
 *
 * The natural column is the longest command plus a gap, capped at a share of
 * the terminal — otherwise one seventy-character command in `profile remove`
 * would push every description in the file off the right-hand edge. A command
 * past the cap keeps its own line and its description begins on the next one,
 * which is what the cap is for rather than a failure of it.
 */
function describeAt(rendered: readonly string[], measure: number): number {
  const longest = Math.max(...rendered.map(visibleWidth), 0);

  // Half, not the more usual third, because `  lanes link ` spends thirteen
  // columns before a command has said anything. A third of eighty leaves
  // twenty-six for the command itself, which is narrower than most of them and
  // would push nearly every description onto a line of its own.
  return Math.max(Math.min(longest + 2, Math.floor(measure * 0.5)), 18);
}

/** One entry's line, as it is measured and as it is shown. */
function spell(entry: Entry): string {
  return `  ${entry.flag === true ? entry.command : `${PROGRAM} ${entry.command}`}`;
}

/**
 * The whole help text, laid out for one width.
 *
 * Two shapes are load-bearing and asserted on by `argv.test.ts` and
 * `instructions.test.ts`, which read this string to find every command the CLI
 * documents. A command is emitted at exactly two spaces, so `/^ {2}\w/` selects
 * the entries and nothing else; a flag begins with `-`, which is not `\w`, so
 * flags are excluded exactly as they were; and every description line is
 * indented at least four, so none can be mistaken for a command.
 */
export function usage(measure: number = width()): string {
  const lines: string[] = wrap(`${PROGRAM} ${BANNER}`, measure).map((line, index) =>
    index === 0 ? line.replace(PROGRAM, style.bold(PROGRAM)) : line,
  );
  const column = describeAt(SECTIONS.flatMap((s) => s.entries).map(spell), measure);

  for (const section of SECTIONS) {
    lines.push('', style.bold(section.title));

    for (const entry of section.entries) {
      // A command may be too long for any terminal — `profile remove` with
      // every flag spelled out is 125 characters. It wraps to a four-column
      // hanging indent, which is deep enough that a continuation can never be
      // mistaken for an entry by the two tests that read this string.
      const spelled = wrap(spell(entry), measure, { hanging: '  ' });
      const last = spelled.at(-1)!;
      for (const line of spelled.slice(0, -1)) lines.push(line);

      if (entry.description === undefined) {
        lines.push(last);
        continue;
      }

      const room = Math.max(measure - column, 20);
      const wrapped = wrap(entry.description, room);
      const fits = visibleWidth(last) + 1 <= column;

      if (fits) {
        lines.push(last + ' '.repeat(column - visibleWidth(last)) + style.dim(wrapped[0] ?? ''));
      } else {
        lines.push(last);
        if (wrapped[0] !== undefined) lines.push(' '.repeat(column) + style.dim(wrapped[0]));
      }

      for (const line of wrapped.slice(1)) lines.push(' '.repeat(column) + style.dim(line));
    }
  }

  lines.push('', ...wrap(FOOTER, measure));

  return lines.join('\n');
}
