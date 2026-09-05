import { paint } from './terminal.ts';

/**
 * Turning text into lines that fit.
 *
 * Pure: nothing here reads the environment, holds state, or writes to a stream.
 * Every function is handed the width it must work to, which is what makes the
 * hard part — wrapping — testable without a terminal.
 *
 * Not named `layout.ts`. That word is taken twice in this tree already
 * (`profile/layout.ts` is the filesystem layout, `cli/contract3-layout.ts` is
 * where contract 3 put things) and both mean something else.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/** The text without its colour, which is the only form worth measuring. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * How many columns a string occupies, as opposed to how long it is.
 *
 * `String.length` counts UTF-16 units, which is wrong three ways and was wrong
 * in `table()` before this existed: an emoji counts two and occupies two, so it
 * was accidentally right; a CJK ideograph counts one and occupies two; a
 * combining accent counts one and occupies nothing. Connection labels and
 * entity names are operator-supplied, so none of these are hypothetical.
 *
 * An approximation of `wcwidth`, not a conformant implementation — it does not
 * resolve ZWJ sequences or regional indicator pairs, and a flag emoji will
 * measure wide twice. Naming that here is cheaper than a bug report about it.
 */
export function visibleWidth(text: string): number {
  let total = 0;

  for (const character of stripAnsi(text)) {
    const code = character.codePointAt(0)!;

    // Combining marks hang off the character before them.
    if (code >= 0x0300 && code <= 0x036f) continue;

    total += isWide(code) ? 2 : 1;
  }

  return total;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** A run of horizontal rule, or nothing at all where there is no room. */
export function rule(count: number): string {
  return count > 0 ? '─'.repeat(count) : '';
}

/**
 * A word, and what it is.
 *
 * Colour is decided per word rather than per span, which is what lets a wrapped
 * line be styled correctly: a quoted phrase broken across two lines is three
 * words that each know they are quoted, so both halves come out painted. The
 * alternative — wrapping a string that already carries escape codes — is the
 * classic way to split a sequence and leak it down the rest of the output.
 */
interface Word {
  readonly text: string;
  readonly paint?: Painter | undefined;
}

type Painter = (text: string) => string;

/**
 * What a step is allowed to pick out of its own prose.
 *
 * Deliberately three patterns and no more. Every one of them is something the
 * reader is meant to *act on* — open it, run it, or type it — which is the only
 * justification for colour inside a sentence. A fourth pattern for emphasis
 * would make the first three mean less.
 */
const SPANS: ReadonlyArray<{ pattern: RegExp; paint: Painter }> = [
  // A URL, minus the punctuation that ends the sentence it sits in.
  { pattern: /https?:\/\/[^\s]+?(?=[.,;:)]*(?:\s|$))/g, paint: paint.link },
  // An invocation of this CLI: the command words, then any flags and values.
  { pattern: /\blanes link(?:\s+(?:--?[\w-]+|<[^>\s]+>|[a-z][\w.-]*))*/g, paint: paint.link },
  // Something the vendor's console calls a thing, which is what to click.
  { pattern: /"[^"]+"/g, paint: paint.accent },
];

/** Which character offsets carry which colour, first pattern winning. */
function spansOf(line: string): Array<Painter | undefined> {
  const marks: Array<Painter | undefined> = new Array(line.length).fill(undefined);

  for (const { pattern, paint: role } of SPANS) {
    for (const match of line.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const from = match.index!;
      for (let at = from; at < from + match[0].length; at += 1) {
        marks[at] ??= role;
      }
    }
  }

  return marks;
}

/**
 * One line of prose, split into words that each know their own colour.
 *
 * `highlight: false` is how a caller says "this is a value, not a sentence" —
 * a credential ref, a path, or a pasted command has nothing to pick out and
 * would only be tinted by accident.
 */
function wordsOf(line: string, highlight: boolean): Word[] {
  const marks = highlight ? spansOf(line) : [];
  const words: Word[] = [];

  for (const match of line.matchAll(/\S+/g)) {
    const at = match.index!;
    words.push({ text: match[0], paint: marks[at] });
  }

  return words;
}

export interface WrapOptions {
  /** Pick out URLs, commands and quoted literals. Off for anything not prose. */
  readonly highlight?: boolean;
  /** Applied to every word that no span claimed — a whole-paragraph tint. */
  readonly paint?: Painter | undefined;
  /** Prefixed to every line after the first, on top of the line's own indent. */
  readonly hanging?: string;
}

/**
 * Break text into lines no wider than `width`.
 *
 * Three things it preserves, each because something in this repository depends
 * on it:
 *
 * - **An embedded newline is a hard break.** Google's setup steps are single
 *   strings containing real newlines, and reflowing across one would run its
 *   sub-headings into the paragraph above.
 * - **A line's own leading whitespace becomes its hanging indent.** The same
 *   steps indent `  BRANDING — …` by two, and a continuation that returned to
 *   column zero would read as a new bullet.
 * - **A word longer than the width is never broken.** The GitHub token URL is
 *   forty-nine characters and has to survive a forty-column terminal intact: a
 *   broken URL cannot be clicked, and a terminal linkifies by contiguity. It
 *   goes on its own line and is allowed to overflow.
 */
export function wrap(text: string, width: number, options: WrapOptions = {}): string[] {
  const { highlight = false, paint: base, hanging = '' } = options;
  const out: string[] = [];

  for (const source of text.split('\n')) {
    const lead = source.match(/^\s*/)![0];
    const words = wordsOf(source, highlight);

    if (words.length === 0) {
      out.push('');
      continue;
    }

    const first = lead;
    const rest = hanging + lead;
    // Never below one, or a narrow pane divides by a room that does not exist
    // and every word lands on a line of its own forever.
    const room = (indent: string) => Math.max(width - visibleWidth(indent), 1);

    let line: Word[] = [];
    let used = 0;
    let indent = first;

    // Adjacent words sharing a colour are painted once, not each. Per-word
    // escapes render identically and cost nothing to look at, but they treble
    // the bytes on the wire and turn a piped log into noise — and a reset
    // between every word is the thing that makes `less -R` output unreadable.
    const flush = (): void => {
      const parts: string[] = [];
      let run: Word[] = [];

      const painterOf = (word: Word): Painter => word.paint ?? base ?? identity;
      const close = (): void => {
        if (run.length === 0) return;
        parts.push(painterOf(run[0]!)(run.map((word) => word.text).join(' ')));
        run = [];
      };

      for (const word of line) {
        if (run.length > 0 && painterOf(run[0]!) !== painterOf(word)) close();
        run.push(word);
      }
      close();

      out.push(indent + parts.join(' '));
      line = [];
      used = 0;
      indent = rest;
    };

    for (const word of words) {
      const size = visibleWidth(word.text);
      const needs = line.length === 0 ? size : used + 1 + size;

      if (line.length > 0 && needs > room(indent)) flush();

      line.push(word);
      used = line.length === 1 ? size : used + 1 + size;
    }

    if (line.length > 0) flush();
  }

  return out;
}

const identity: Painter = (text) => text;

/**
 * A numbered list whose continuations align under the text, not the number.
 *
 * The gutter is sized from the largest number rather than fixed, so a
 * nine-step provider and a twelve-step one both line up with themselves. The
 * previous rendering was `\`  ${index + 1}. ${step}\`` and had no continuation
 * at all — a step ran to the edge of the terminal and carried on at column
 * zero, which is what made a seven-step walkthrough read as one paragraph.
 */
export function numbered(items: readonly string[], width: number): string[] {
  const gutter = String(items.length).length;
  const out: string[] = [];

  items.forEach((item, index) => {
    const marker = String(index + 1).padStart(gutter);
    const hanging = ' '.repeat(gutter + 4);

    const [head, ...tail] = wrap(item, width - gutter - 4, {
      highlight: true,
      hanging: '',
    });

    out.push(`  ${paint.muted(marker)}  ${head ?? ''}`);
    for (const line of tail) out.push(hanging + line);
  });

  return out;
}
