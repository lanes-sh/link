/**
 * "Did you mean --profile?" — one edit away, and no further.
 *
 * Pulled out of `selection.ts`, which is the table of what each command needs
 * and the checks that enforce it. Guessing at a misspelling is neither: it is
 * string distance, it has no idea what a flag is, and the reason it lives
 * beside that file rather than inside it is that the file kept growing every
 * time a command was added and this never did.
 */

/**
 * The closest accepted flag, when there is an obviously close one.
 *
 * One edit away, or one transposition — enough for `--porfile` and `--taget`,
 * and short of guessing at something the operator did not mean. A wrong guess
 * here costs more than no guess: it sends them to a flag that is not the answer.
 */
export function nearest(given: string, allowed: ReadonlySet<string>): string | undefined {
  for (const candidate of allowed) {
    if (Math.abs(candidate.length - given.length) > 1) continue;
    if (distance(given, candidate) <= 1) return candidate;
    if (sorted(given) === sorted(candidate)) return candidate;
  }
  return undefined;
}

const sorted = (text: string): string => [...text].sort().join('');

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }

  return row[b.length]!;
}
