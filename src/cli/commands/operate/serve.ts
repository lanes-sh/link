import { readSession } from '#auth/lanes/session.ts';
import { ConfigError } from '#profile';
import { startEndpoint } from '#server/endpoint.ts';
import { streamLogger } from '#server/logging.ts';
import { repairOwnerLayer } from '../../config-repair.ts';
import { announce, ok, print, style, warn } from '../../output.ts';
import { staleNudge } from '../../release.ts';
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

  await requireSignIn();

  // Before the bootstrap, and only here.
  //
  // This is the one command an existing install runs without being told to, so
  // it is how a profile written before ADR-050 comes to have memory, tasks,
  // assets, skills and the vault at all — `connect` and `deploy` repair too, but
  // someone who is already set up may not run either for months. What it writes
  // is the rows and rules a fresh profile is created with; a `deny` covering a
  // surface is left alone, which is how one stays off.
  //
  // Not inside `startEndpoint`, which the container entrypoint also calls: a
  // deployed revision holds `objectViewer` on `profiles/` (ADR-023) and must not
  // be the thing that edits config. The repair belongs to the control plane
  // (ADR-007), and this is the control plane.
  //
  // Scoped as the serving is: `--only` serves one profile, so it repairs one.
  await repairOwnerLayer(
    resolution.workspaceRoot,
    flags.only ? [resolution.profile] : undefined,
  );

  // The bootstrap itself lives in `endpoint.ts`, shared with the container
  // entrypoint. What stays here is what a terminal wants: the plan, printed as
  // it is applied, and the endpoint at the end.
  const endpoint = await startEndpoint({
    flags,
    port: flags.port,
    only: flags.only,
    mintToken: true,
    // Stderr, not stdout: `--json` and `--raw` callers parse the other stream.
    // A refused credential is the event worth seeing while this runs in the
    // foreground, and until now nothing printed it.
    log: streamLogger((line) => process.stderr.write(`${line}\n`)),
    reporter: {
      reconciled({ profile, plan, ofMany }) {
        if (ofMany) print(style.dim(`  ${profile}`));
        print(plan);
        print(ok(`reconciled ${ofMany ? profile : ''}`.trim()));
      },
      tokenMinted({ target }) {
        print(warn(`minted a token — run: lanes link outputs --show --workspace ${target}`));
      },
    },
  });

  print(ok(`serving ${style.bold(endpoint.url)}`));
  print(style.dim(`      profiles: ${endpoint.profiles.join(', ')}`));

  // Last, not first: the endpoint is what someone ran this for, and a version
  // note in front of it would be the first thing they read and the least useful.
  const stale = await staleNudge();
  if (stale !== null) print(warn(stale));

  print(style.dim('Ctrl-C to stop.'));

  const shutdown = async (): Promise<void> => {
    await endpoint.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}

/**
 * Refuse to serve without a Lanes session.
 *
 * A local endpoint requires this as much as a deployed one does, which is the
 * uncomfortable half of ADR-060 and worth stating plainly: **a self-hostable
 * tool now needs an account to start.** The alternative was worse. A profile
 * declares who may consume it, and there is no way to check that against
 * anybody if the endpoint has no idea who is asking — so "local is exempt"
 * means local profiles cannot express delegation at all, and the model would be
 * two models.
 *
 * What is *not* required is the network per request. A machine offline for a
 * day keeps serving; the session is needed to sign in and to refresh, and
 * `lanes auth status` says how long that has left to run.
 *
 * The CI token is the exception and stays one (ADR-009): a headless runner has
 * no browser, presents `llk_…`, and reaches the whole workspace.
 */
async function requireSignIn(): Promise<void> {
  if ((await readSession()) !== null) return;

  throw new ConfigError(
    'Not signed in, so there is nobody for this endpoint to serve.\n' +
      '  Run: lanes auth login\n' +
      '\n' +
      '  A profile reaches you only where its members list your subject, which is why\n' +
      '  this is required for a local endpoint too. See:\n' +
      '    lanes link profile members add --me --profile <name>',
  );
}
