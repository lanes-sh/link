import { announce, ok, print, style, warn } from '../../output.ts';
import { ensureProfileToken, openRuntime, type GlobalFlags } from '../../runtime.ts';

/** `lanes link token` — the one bearer token this endpoint accepts. */

/** The token, or enough of it to recognise. One shape, so the two commands agree. */
function show(token: string, reveal: boolean | undefined): string {
  return reveal ? token : `${token.slice(0, 8)}…  ${style.dim('(--show to reveal)')}`;
}

export async function tokenShow(
  flags: GlobalFlags & { show?: boolean | undefined; raw?: boolean | undefined },
): Promise<void> {
  const runtime = await openRuntime(flags);
  try {
    const { token, created } = await ensureProfileToken(
      runtime.credentials,
      runtime.config.auth.token_ref,
    );

    // `--raw` prints the token and nothing else, for command substitution:
    //
    //   claude mcp add … --header "Authorization: Bearer $(lanes link token show --raw)"
    //
    // That is the recommended way to register an instance, and the reason is
    // not convenience. A token pasted from `--show` passes through the agent's
    // context and into its transcript; substituted by the shell it goes from
    // this process to the harness and is never seen by the model at all.
    if (flags.raw) {
      process.stdout.write(`${token}\n`);
      return;
    }

    announce(runtime.resolution);
    if (created) print(warn('no token existed; a new one was minted'));
    print(show(token, flags.show));
  } finally {
    await runtime.close();
  }
}

export async function tokenRotate(
  flags: GlobalFlags & { show?: boolean | undefined },
): Promise<void> {
  const runtime = await openRuntime(flags);
  try {
    announce(runtime.resolution);

    const { generateProfileToken } = await import('#auth');
    const token = generateProfileToken();
    await runtime.credentials.set(runtime.config.auth.token_ref, token);

    print(ok('token rotated'));
    // Gated the way `tokenShow` gates it, and for the reason given above: a
    // token printed here goes into the transcript of whatever ran the command.
    // Rotating is what an operator does *because* a token leaked, so printing
    // the replacement unasked is the one moment it costs the most.
    print(`  ${show(token, flags.show)}`);
    print();
    // Rotating invalidates every agent using this endpoint, which is the cost
    // of one token per endpoint rather than one per agent. Say so plainly —
    // and say how, because `claude mcp add` stores the substituted value rather
    // than the command, so nothing re-reads this on its own.
    print(warn('every agent configured with the old token must be re-registered'));
    print(style.dim('  A harness stores the token it was given, not the command that produced it.'));
    print(style.dim('  Run: lanes link outputs   for the command to re-run.'));
  } finally {
    await runtime.close();
  }
}
