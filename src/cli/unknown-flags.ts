import { ConfigError } from '#profile';
import type { Flags } from './argv.ts';
import { nearest } from './nearest.ts';

/**
 * Refuse a flag this command does not read, and guess what was meant.
 *
 * This is the fix for a reported bug rather than a nicety. `profile add
 * --workspace cloud` was accepted and dropped, and nothing could refuse it
 * because `parseArgv` returns every `--anything` it sees and no command ever
 * inspected the leftovers. A typo was swallowed the same way on every command in
 * the CLI.
 *
 * It lives here, rather than inside `assertKnownFlags` where it was written,
 * because `lanes auth` is not in the `link` area and so never reached that
 * function: `lanes.ts` routes it before `main.ts`, which is where the check is
 * called. The allowlist is the caller's to state — `selection.ts` derives one
 * from its tables, and `auth-dispatch.ts` writes out the three flags it reads —
 * but the refusal must be the same one, or the two areas disagree about whether
 * a mistyped flag is an error.
 *
 * What it cost while `auth` was outside it: `lanes auth login --api_url <url>`
 * dropped the flag, and `login` then fell back to `LANES_API_URL` and finally to
 * the default. So a sign-in aimed at a self-hosted broker silently went to the
 * default one, and nothing on the success path names the broker it used. The
 * subject that comes back is minted by the wrong identity provider, so the
 * profile that lists the right one refuses it — which presents as "signed in,
 * but not a member" rather than as a typo.
 */
export function refuseUnknownFlags(
  named: string,
  allowed: ReadonlySet<string>,
  flags: Flags,
): void {
  for (const given of Object.keys(flags)) {
    if (allowed.has(given)) continue;

    const guess = nearest(given, allowed);
    throw new ConfigError(
      `Unknown flag "--${given}" for "${named}".` +
        (guess ? `\n  Did you mean --${guess}?` : '') +
        `\n  Accepts: ${[...allowed].sort().map((name) => `--${name}`).join(' ')}`,
    );
  }
}
