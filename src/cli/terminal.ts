/**
 * What this terminal can do, and what Lanes looks like on it.
 *
 * Two questions with one answer each — how wide, and how much colour — and both
 * are read from the environment on every call rather than captured once. That is
 * not a style preference: `style` used to close over a module-load constant,
 * which made colour impossible to test without a pty and made a terminal resize
 * invisible for the life of the process.
 *
 * The seam to cut on if this file outgrows the budget is palette versus
 * capability: `level()` and `columns()` describe the terminal, `paint` describes
 * Lanes. They are together here because the palette is *defined* as a fallback
 * ladder over the capability, and splitting them would put the ladder's two
 * halves in two files.
 */

/** No terminal said how wide it is — what every other tool assumes. */
const FALLBACK_COLUMNS = 80;

/**
 * The widest a paragraph is allowed to get, and the narrowest it may be asked
 * to fit.
 *
 * Ninety because readable measure runs out somewhere under a hundred: the GitHub
 * summary is 274 characters, which is three lines at 90 and an indistinct block
 * at 140. Forty because the arithmetic below it goes negative — a heading's rule
 * is `width - heading - 1`, and `'─'.repeat(-3)` throws. Clamping means a
 * 30-column pane overflows into the emulator's own wrap, which is ugly, rather
 * than crashing, which is worse.
 */
const MAX_MEASURE = 90;
const MIN_MEASURE = 40;

/**
 * How wide the terminal says it is.
 *
 * `COLUMNS` first because it is the conventional override and the only knob a
 * test, a CI job, or `script` has. `process.stdout.columns` is only ever set on a
 * TTY, and stderr is consulted after it because the setup block narrates there —
 * a run with stdout piped and stderr on the terminal still knows the width of
 * the thing a person is reading.
 */
export function columns(): number {
  const declared = Number(process.env['COLUMNS']);
  if (Number.isInteger(declared) && declared > 0) return declared;

  const out = process.stdout.columns;
  if (typeof out === 'number' && out > 0) return out;

  const err = process.stderr.columns;
  if (typeof err === 'number' && err > 0) return err;

  return FALLBACK_COLUMNS;
}

/**
 * The measure to lay text out in.
 *
 * One column short of the terminal, deliberately. A line that exactly fills the
 * width makes many emulators emit a phantom wrap, which puts a blank line
 * between every rule and the text under it — and reads as a bug in the spacing
 * rather than in the arithmetic.
 */
export function width(): number {
  return Math.min(Math.max(columns() - 1, MIN_MEASURE), MAX_MEASURE);
}

/** How much colour this terminal renders: none, 16, 256, or 16 million. */
export type Level = 0 | 1 | 2 | 3;

/**
 * Which rung of the ladder to paint on.
 *
 * The TTY gate is stdout's, which is the rule this CLI has always used and is
 * kept rather than improved: deciding per stream would mean `style.bold` had to
 * know where its result was going, and 468 call sites say it does not.
 *
 * `FORCE_COLOR` was not honoured before. It is here because it is the only way
 * to exercise rungs 2 and 3 from a test or a CI job, and a ladder nothing can
 * climb on purpose is a ladder nobody checks. It follows the spelling everyone
 * else uses: `0` off, `1`/`2`/`3` a rung, and anything else — `true`, or the
 * bare variable — meaning *on*, with the rung still inferred.
 */
export function level(): Level {
  const force = process.env['FORCE_COLOR'];
  const noColor = process.env['NO_COLOR'];

  if (noColor !== undefined && noColor !== '') return 0;
  if (force === '0') return 0;
  if (process.env['TERM'] === 'dumb') return 0;
  if (force === undefined && process.stdout.isTTY !== true) return 0;

  // Said before inferred. `FORCE_COLOR=2` on a terminal that also exports
  // `COLORTERM=truecolor` has to mean 256 — it is somebody overriding the
  // guess, and a guess that outranked them would make the variable useless for
  // the one thing it is for.
  if (force === '3') return 3;
  if (force === '2') return 2;
  if (force === '1') return 1;

  if (/truecolor|24bit/i.test(process.env['COLORTERM'] ?? '')) return 3;
  if (/-256(color)?$/.test(process.env['TERM'] ?? '')) return 2;

  return 1;
}

const sgr = (code: string) => (text: string) => `[${code}m${text}[0m`;

/**
 * The six codes this CLI has always had, now resolved per call.
 *
 * Kept exactly as they were — and re-exported from `output.ts` — so that moving
 * them here is not a change to any of the sixty-five files that use them.
 */
const basic = (code: string) => (text: string) => (level() === 0 ? text : sgr(code)(text));

export const style = {
  bold: basic('1'),
  dim: basic('2'),
  green: basic('32'),
  yellow: basic('33'),
  red: basic('31'),
  cyan: basic('36'),
};

/**
 * One brand colour, not two, and the reason is that a terminal cannot be asked.
 *
 * `brand.ts` carries an emerald per colour scheme — `#059669` on light,
 * `#34D399` on dark — because a browser reports `prefers-color-scheme`. A
 * terminal reports nothing, so a fixed choice of either is wrong half the time.
 * `#10B981` sits between them and stays legible on both a near-black and a
 * near-white background, which is the only property that matters when the
 * background is unknown.
 *
 * `COLORFGBG` is the exception: where a terminal does declare its background
 * (`fg;bg`, with 0-6 dark and 7-15 light) the exact brand pair is used instead.
 * Most terminals do not set it, which is why it refines the answer rather than
 * deciding it.
 */
const ACCENT_MID = [16, 185, 129] as const;
const ACCENT_ON_DARK = [52, 211, 153] as const;
const ACCENT_ON_LIGHT = [5, 150, 105] as const;

type Rgb = readonly [number, number, number];

function accentRgb(): Rgb {
  const background = Number(process.env['COLORFGBG']?.split(';').at(-1));
  if (!Number.isInteger(background)) return ACCENT_MID;
  return background >= 7 ? ACCENT_ON_LIGHT : ACCENT_ON_DARK;
}

/**
 * A role, resolved down the ladder.
 *
 * The 256-colour indices are computed from the 6x6x6 cube rather than chosen by
 * eye: `16 + 36r + 6g + b` over the [0, 95, 135, 175, 215, 255] steps, taking
 * the nearest step per channel. They are the closest the palette holds to each
 * hex above it, and writing that down is what stops the next person "correcting"
 * one to a number that looks better in isolation.
 */
function role(rgb: () => Rgb, cube: number, ansi: string): (text: string) => string {
  return (text: string) => {
    switch (level()) {
      case 0:
        return text;
      case 3: {
        const [r, g, b] = rgb();
        return sgr(`38;2;${r};${g};${b}`)(text);
      }
      case 2:
        return sgr(`38;5;${cube}`)(text);
      default:
        return sgr(ansi)(text);
    }
  };
}

/**
 * What each colour means, so that a call site names a role and never a colour.
 *
 * `muted` and `strong` are dim and bold at every rung: they are weight rather
 * than hue, and a terminal that renders no colour still renders both.
 */
export const paint = {
  /** The Lanes accent. Prompts, and the literals a step tells you to type. */
  accent: role(accentRgb, 36, '32'),
  /** A URL or a command — something to click, copy, or run. */
  link: role(() => [8, 145, 178], 31, '36'),
  /** Something survivable that the reader should still see. */
  warn: role(() => [180, 83, 9], 130, '33'),
  /** Something that failed. */
  danger: role(() => [160, 96, 96], 131, '31'),
  /** Secondary prose, rules, and step numbers. */
  muted: style.dim,
  /** A heading. */
  strong: style.bold,
};
