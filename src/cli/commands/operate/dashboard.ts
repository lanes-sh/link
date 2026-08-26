import { deploymentIdentity, endpointHealth, localUrl } from '../../endpoint-url.ts';
import { defaultOpenBrowser } from '../../oauth.ts';
import { announce, ok, print, style, warn } from '../../output.ts';
import {
  ensureProfileToken,
  openRuntime,
  resolveProfile,
  type GlobalFlags,
} from '../../runtime.ts';

/**
 * `lanes link dashboard` — open the page this endpoint serves.
 *
 * The command exists because the page cannot be reached without it. A browser
 * navigating to `/dashboard` carries no `Authorization` header, so the token has
 * to arrive some other way, and the only place it already exists is the
 * credential store this command can read. It puts it in the URL once; the
 * endpoint exchanges it for a session cookie and redirects to a URL without it.
 *
 * Local only, deliberately. See `#server/dashboard.ts` — ADR-018 leaves a
 * deployed instance with no door a person at a browser can come through, and a
 * command that opened a loopback URL for a target that is not there would be
 * reporting success for a page nobody can load.
 */

export interface DashboardFlags extends GlobalFlags {
  /** Print the URL instead of opening it. */
  readonly print?: boolean | undefined;
}

export async function dashboard(flags: DashboardFlags): Promise<void> {
  // `resolveProfile` rather than `openRuntime`, and the order is the point.
  // Opening a runtime opens that target's adapters, so a deployed target sends
  // this command to Secret Manager and a bucket before it can say the one thing
  // it needs to — that the dashboard is not there. The refusal below would
  // still be correct and nobody would ever read it, because a storage 403
  // arrives first. This is the seam `runtime.ts` documents `deploy` and
  // `secrets push` stopping at, for the same reason.
  const { resolution, config, target } = await resolveProfile(flags);
  announce(resolution);

  const deployed = deploymentIdentity(config.targets[target]?.deploy);
  if (deployed) {
    throw new Error(
      `Target "${target}" is deployed to ${deployed.platform}, and the dashboard is served only ` +
        'by a local endpoint — a browser carries no bearer token, and Cloud Run\'s own gate ' +
        'admits only a Google-signed identity token it cannot mint either (ADR-018).\n' +
        `What a deployed target can answer: ` +
        `lanes link status --profile ${resolution.profile} --target ${target}`,
    );
  }

  const runtime = await openRuntime(flags);

  try {
    const { token } = await ensureProfileToken(runtime.credentials, runtime.config.auth.token_ref);

    const url = new URL(localUrl(runtime.config));
    url.pathname = '/dashboard';
    url.searchParams.set('k', token);
    // Named rather than left to the endpoint's primary, so the page opens on
    // the profile this command resolved and printed above.
    url.searchParams.set('profile', runtime.resolution.profile);

    // The page is served by a running endpoint or by nothing. Saying so here
    // beats opening a browser at a connection error.
    const live = await endpointHealth(localUrl(runtime.config), token);
    if (!live) {
      // Both flags on both lines. They read as correct without them only
      // because they were written while a missing one still resolved to the
      // workspace default; with nothing to fall back on (ADR-037) each is a
      // paste that refuses, and this one is printed at the moment somebody is
      // least able to guess what it wanted.
      const where = `--profile ${runtime.resolution.profile} --target ${target}`;

      print(warn(`nothing is serving this port — run: lanes link start ${where}`));
      print(style.dim(`  then: lanes link dashboard ${where}`));
      return;
    }

    if (!live.profiles.includes(runtime.resolution.profile)) {
      // `start --only` serves one profile. The URL would 404 on the rest, which
      // is honest but unhelpful without being told why.
      print(
        warn(
          `the endpoint on this port serves ${live.profiles.join(', ')} — ` +
            `not "${runtime.resolution.profile}"`,
        ),
      );
      return;
    }

    if (flags.print) {
      // Printed, not opened: for a terminal on a machine with no browser, and
      // for anyone who would rather see what they are about to open. It carries
      // the token, which is why it is behind a flag rather than always shown.
      print(url.href);
      return;
    }

    defaultOpenBrowser(url.href);
    print(ok(`opened ${style.bold(`${url.origin}/dashboard`)}`));
    print(style.dim('  the link carries a one-time key; the page swaps it for a session cookie.'));
  } finally {
    await runtime.close();
  }
}
