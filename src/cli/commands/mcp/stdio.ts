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
  // Its own refusal, written for the only person who will read it: someone
  // looking at a client's MCP log after the server "disconnected". There is no
  // command line here to add a flag to — the client's config file is the only
  // place that can carry one — so the message has to be a paste rather than an
  // instruction, and the generic "pass --profile" would be advice with nowhere
  // to follow it.
  if (!flags.profile || !flags.target) {
    printErr(
      'lanes link mcp stdio needs --profile and --target in its "args".\n' +
        '\n' +
        '  This client spawns the endpoint, so its config file is the only place\n' +
        '  that can say which profile and target it serves:\n' +
        '\n' +
        '    "lanes-link": {\n' +
        '      "command": "/path/to/lanes",\n' +
        '      "args": ["link","mcp","stdio","--profile","<name>","--target","<name>"]\n' +
        '    }\n',
    );
    process.exit(1);
  }

  const endpoint = await startStdioEndpoint({
    flags,
    ...(flags.only ? { only: true } : {}),
    reporter: {
      reconciled: ({ profile, plan, ofMany }) =>
        printErr(`${ofMany ? `${profile}\n` : ''}${plan}`),
      // Unreachable: this path never mints a token, because it never needs one.
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
