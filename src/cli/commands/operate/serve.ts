import { startEndpoint } from '#server/endpoint.ts';
import { announce, ok, print, style, warn } from '../../output.ts';
import { resolveProfile, type GlobalFlags } from '../../runtime.ts';

/** `lanes link start` — reconcile, then serve every profile on one endpoint. */

export async function start(
  flags: GlobalFlags & {
    port?: number | undefined;
    /** `--only` serves just the resolved profile, rather than the whole workspace. */
    only?: boolean | undefined;
  },
): Promise<void> {
  const { resolution } = await resolveProfile(flags);
  announce(resolution);

  // The bootstrap itself lives in `endpoint.ts`, shared with the container
  // entrypoint. What stays here is what a terminal wants: the plan, printed as
  // it is applied, and the endpoint at the end.
  const endpoint = await startEndpoint({
    flags,
    port: flags.port,
    only: flags.only,
    mintToken: true,
    reporter: {
      reconciled({ profile, plan, ofMany }) {
        if (ofMany) print(style.dim(`  ${profile}`));
        print(plan);
        print(ok(`reconciled ${ofMany ? profile : ''}`.trim()));
      },
      tokenMinted() {
        print(warn('minted a token — run: lanes link outputs --show'));
      },
    },
  });

  print(ok(`serving ${style.bold(endpoint.url)}`));
  print(style.dim(`      profiles: ${endpoint.profiles.join(', ')}`));
  print(style.dim('Ctrl-C to stop.'));

  const shutdown = async (): Promise<void> => {
    await endpoint.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}
