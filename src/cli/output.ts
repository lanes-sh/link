import type { Resolution } from '#profile';

/**
 * Terminal output.
 *
 * Everything a command produces goes to stdout; diagnostics go to stderr. That
 * split matters because `lanes link token show` and `lanes link outputs` print values people
 * pipe into other tools, and a log line interleaved into a token corrupts it.
 */

const isTTY = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const paint = (code: string) => (text: string) => (isTTY ? `[${code}m${text}[0m` : text);

export const style = {
  bold: paint('1'),
  dim: paint('2'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  cyan: paint('36'),
};

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * A "what is happening now" line — setup instructions, a wait, a step done.
 *
 * Goes to stderr because it is not what the command produces: a person reading
 * a terminal sees it exactly as before, and `--json` keeps a parseable stdout
 * without every intermediate note having to know whether anyone is parsing.
 * The split at the top of this file already said this; `connect` was the one
 * command narrating on the channel it also returns its result on.
 */
export function progress(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Say what is being waited on, and keep saying it until it arrives.
 *
 * Shelling out to `gcloud` costs seconds, and a prompt that is *about* to be
 * printed looks exactly like a prompt that is waiting for you. An operator
 * pressed return into that silence, the keystroke was buffered by the terminal,
 * and the next question — the one they never saw — consumed it as an answer.
 * A survey that writes its answers to a config file cannot afford that.
 *
 * It animates, which is the part that does the work. A static line saying what
 * is happening is invisible when the wait is short and indistinguishable from a
 * frozen terminal when it is long — the two cases it exists for. Motion is the
 * only thing on a terminal that says "still going" rather than "still here",
 * and after three seconds it starts counting, because by then the useful
 * question is how long rather than whether.
 *
 * Erased on a TTY so the finished output reads as if the wait never happened,
 * and left in place otherwise: in a log or a pipe, "checking…" with no matching
 * line after it is the only record that the step was reached at all.
 */
const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

/** Carriage return, then erase to end of line. */
const CLEAR = '\r\u001b[2K';

export async function waiting<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (!isTTY) {
    progress(style.dim(`  ${label}\u2026`));
    return work();
  }

  const started = Date.now();
  let frame = 0;

  const draw = (): void => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    // Only once it has been long enough to be worth wondering about. A counter
    // that appears immediately reads as a countdown to something.
    const elapsed = seconds >= 3 ? ` (${seconds}s)` : '';
    const mark = SPINNER[frame % SPINNER.length];

    process.stderr.write(`${CLEAR}${style.dim(`  ${mark} ${label}\u2026${elapsed}`)}`);
    frame += 1;
  };

  draw();
  const ticker = setInterval(draw, 90);
  // A wait must never be why a process stays alive. If the work settles and
  // something later throws past the `finally`, a referenced interval leaves the
  // CLI hanging with nothing on screen to explain it.
  ticker.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(ticker);
    process.stderr.write(CLEAR);
  }
}

/**
 * The line every command prints before acting, read-only commands included.
 *
 * This is the primary guard against operating on the wrong instance, and it
 * costs one line. It used to name where each value came from, which mattered
 * while four things could supply them. Only the command line can now (ADR-037),
 * so the parenthetical would say `(flag)` twice on every line forever — which
 * `target.ts` already argues is how a line stops being read.
 */
/**
 * The same line for a command that opens no target.
 *
 * `identity list` reads a block declared once in the YAML, so it takes no
 * `--target` (ADR-037) and there is none to name. Printing `target undefined`
 * or omitting the line entirely were the alternatives; the first is a lie and
 * the second loses the guard that this line exists to be.
 */
export function announceProfile(selection: {
  readonly profile: string;
  readonly workspaceRoot: string;
}): void {
  print(style.dim(`profile ${style.bold(selection.profile)}  ${selection.workspaceRoot}`));
}

export function announce(resolution: Resolution): void {
  print(
    style.dim(
      `profile ${style.bold(resolution.profile)}  ` +
        `target ${style.bold(resolution.target)}  ` +
        `${resolution.workspaceRoot}`,
    ),
  );
}

/**
 * Print a machine-readable result, or fall through to the human rendering.
 *
 * The early return is the whole point. `announce` is the first thing every
 * command prints — including read-only ones, deliberately — and a line of prose
 * in front of a JSON document corrupts it for whatever is parsing. `outputs`
 * got that right by hand; putting the guard here means the next `--json`
 * command cannot get it wrong, and there is one place to look when one does.
 *
 * The payload is built before this is called rather than inside `render`, so
 * both renderings describe the same snapshot.
 */
export function emit(
  json: boolean | undefined,
  value: unknown,
  render: () => void | Promise<void>,
): void | Promise<void> {
  if (json === true) {
    print(JSON.stringify(value, null, 2));
    return;
  }

  return render();
}

export function heading(text: string): void {
  print();
  print(style.bold(text));
}

export function table(rows: ReadonlyArray<readonly string[]>): void {
  if (rows.length === 0) return;

  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, stripAnsi(cell).length);
    });
  }

  for (const row of rows) {
    print(
      row
        .map((cell, index) =>
          index === row.length - 1
            ? cell
            : cell + ' '.repeat((widths[index] ?? 0) - stripAnsi(cell).length),
        )
        .join('  ')
        .trimEnd(),
    );
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

export const ok = (text: string) => `${style.green('ok')}    ${text}`;
export const warn = (text: string) => `${style.yellow('warn')}  ${text}`;
export const fail = (text: string) => `${style.red('fail')}  ${text}`;
