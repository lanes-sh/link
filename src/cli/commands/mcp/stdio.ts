import { printErr } from '../../output.ts';
import type { GlobalFlags } from '../../runtime.ts';
import { startStdioEndpoint } from '#server/endpoint.ts';

/**
 * `lanes link mcp stdio` — serve this workspace on stdin and stdout.
 *
 * Not a command anyone types. It is what a client's config file names, so the
 * client spawns it: Claude Desktop validates each `mcpServers` entry against
 * `{ command, args?, env?, extensionId? }` and has no `url` field, so an HTTP
 * endpoint is not something it can be pointed at.
 *
 * Such a client also has nowhere to install a skill, which is the case the
 * server's own `instructions` exist for — it arrives over this pipe like any
 * other, in the `initialize` response.
 *
 * Nothing may be written to stdout here — it is the wire. Reconcile output and
 * errors go to stderr, where a client's log captures them.
 */
export async function mcpStdio(
  flags: GlobalFlags & { only?: boolean | undefined },
): Promise<void> {
  const endpoint = await startStdioEndpoint({
    flags,
    ...(flags.only ? { only: true } : {}),
    reporter: {
      reconciled: ({ profile, plan, ofMany }) =>
        printErr(`${ofMany ? `${profile}\n` : ''}${plan}`),
      // Unreachable: this path never mints a token, because it never needs one.
      tokenMinted: () => {},
    },
    log: {
      debug() {},
      info() {},
      warn: (message, fields) => printErr(`warn  ${message} ${JSON.stringify(fields ?? {})}`),
      error: (message, fields) => printErr(`error ${message} ${JSON.stringify(fields ?? {})}`),
    },
  });

  const stop = async (code: number): Promise<never> => {
    await endpoint.stop();
    process.exit(code);
  };

  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));

  // The client owns the lifetime: it spawned this process, and closing the pipe
  // is how it says it is done. Without this the process outlives the client that
  // started it, holding a database handle open for nobody.
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });

  await endpoint.stop();
}
