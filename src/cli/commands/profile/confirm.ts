import { ConfigError } from '#profile';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { print, style } from '../../output.ts';

/**
 * Asking somebody to mean it.
 *
 * Split from `remove.ts` along the seam that file already had: the other three
 * things in it plan a removal, perform one, and render what happened, and this
 * one is the interaction in front of all of them. The budget in
 * `architecture.test.ts` is what pointed at it — `remove.ts` sat six lines under
 * 400, so the first real change to it went over, which is the case that budget
 * describes as "not too long, two things".
 *
 * Still local to this folder rather than promoted beside `agreed()`. The
 * argument the original carried holds: the shape differs, there is one caller,
 * and bending the shared helper for it would leave both worse. If a second
 * consumer appears, promote it then.
 */

/**
 * The confirmation, which asks for the name rather than a keystroke.
 *
 * A step up from `agreed()`, deliberately. That helper is `y/N` and is right
 * for `vault remove`, which drops one item the operator can put back. This
 * drops every live OAuth refresh token a profile holds, and putting those back
 * means visiting each vendor again — so the gesture should be one you cannot
 * make by leaning on the keyboard.
 *
 * Local rather than shared for the same reason it is not `agreed()`: the shape
 * differs, and bending the existing helper for a single caller in another
 * command folder would leave both worse. If a second consumer appears, promote
 * it then.
 */
export async function confirmedByName(
  profile: string,
  options: { yes?: boolean | undefined; prompter?: Prompter | undefined },
): Promise<boolean> {
  if (options.yes) return true;

  // A prompter that was passed in is the caller's answer to "is there anyone
  // to ask" — the console passes one that replays a form. Only the default
  // needs stdin consulted, and conflating the two makes an injected prompter
  // untestable and a real terminal the only place this works.
  const prompter = options.prompter ?? terminalPrompter;
  const someoneToAsk = options.prompter ? prompter.interactive : process.stdin.isTTY;

  if (!someoneToAsk) {
    throw new ConfigError(
      `Removing "${profile}" cannot be undone, and stdin is not a terminal, so there is nobody to ask. Pass --yes to proceed.`,
    );
  }

  const typed = (await prompter.ask(`Type ${profile} to remove it, or anything else to stop`))
    .trim();

  if (typed !== profile) {
    print(style.dim('  cancelled — nothing was removed'));
    return false;
  }
  return true;
}
