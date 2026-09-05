import type { DeployConfig } from '#profile';
import { heading, ok, print, prose, style, warn } from '#cli/output.ts';

/**
 * What a deploy tells the operator, as against what it does.
 *
 * Split out of `deploy.ts` because that file is the ordered list of things that
 * have to happen to roll a revision, and this is none of them: which door the
 * platform left open, whether the endpoint came up, how to register it, and
 * which credentials the revision will find missing. Every one of these runs
 * before or after the rollout and changes nothing about it.
 *
 * They are worth keeping together. Each is a sentence someone acts on — two of
 * them are commands to paste — and the failure they exist against is a deploy
 * that succeeds and leaves the operator with a URL and no idea what to do next.
 */

/**
 * How to register the endpoint, and when.
 *
 * The ordering is the whole point of the second half. A client captures
 * `tools/list` when it connects and keeps it: this endpoint is stateless, so
 * there is no stream on which to send `notifications/tools/list_changed`, and
 * `buildMcpServer` no longer pretends otherwise. A first deploy necessarily
 * publishes a profile whose only connection is `lanes_setup.lan1` — the accounts come
 * after — so a connector registered in that window captures a two-tool surface
 * and holds it. The endpoint is right, every reload lands, and the client shows
 * two tools until someone removes and re-adds it.
 *
 * Unconditional, and that is the correction that matters. This was gated on
 * `prepared.warnings.length`, which is zero in precisely the case it describes:
 * a fresh profile declares only `lanes_setup.lan1`, and it is a local provider with
 * no credential, so `prepareSecrets` has nothing to warn about. The advice
 * appeared only on a later re-deploy, by which point the connector is usually
 * registered and the ordering is no longer available to get right.
 */
export function registerLine(profile: string, target: string): string {
  return style.dim(
    `  Connect your accounts first, then register with:\n` +
      `    lanes link outputs --profile ${profile} --workspace ${target}\n` +
      '  A client keeps the tool list it fetched when it connected, so one registered\n' +
      '  before the accounts holds a surface without them until it is re-added.\n' +
      '  One registered before this deploy holds the list from before it, so a version\n' +
      '  that renamed a provider or an id leaves it calling names that are gone:\n' +
      '    lanes link mcp add',
  );
}

/**
 * The accounts a browser still has to authorise, and the step after them.
 *
 * Printed last rather than before the build, because this is the only thing
 * left to do and a list eight steps up the scrollback is a list nobody reads.
 *
 * There is no second deploy at the end of it any more, and the reason the old
 * one existed is worth keeping. Connection *credentials* are read live on every
 * call, so a fresh `connect` looked like it should be picked up — but whether a
 * connection was usable at all was decided by a reconcile that ran once per
 * process, so a revision that came up with an account unauthorised went on
 * refusing it, naming the connection rather than the staleness. Reconcile now
 * runs again on every reload, and `connect` asks for one (ADR-029).
 */
export function reportUnauthorised(warnings: readonly string[], profile: string, target: string): void {
  if (warnings.length === 0) return;

  heading('Not authorised yet');
  for (const problem of warnings) prose(problem, { prefix: warn('') });
  print('');
  prose('  A browser consent per account is the one step this cannot take for you:', {
    paint: style.dim,
  });
  // Printed rather than wrapped, alone among these lines: it is meant to be
  // pasted, and a break inserted into it is a break in what somebody copies.
  print(
    `    ${style.dim(`lanes link connect <provider> --profile ${profile} --workspace ${target}`)}`,
  );
  prose(
    '  Each is served as soon as it is authorised. There is no second deploy — deploying is how code gets here, and authorising an account changes none.',
    { paint: style.dim },
  );
}

/**
 * Who can reach the service once this lands.
 *
 * Printed on every deploy rather than only when it changes, because it is the
 * one property of a deployment that is invisible from the outside until someone
 * either cannot get in or should not have been able to.
 */
export function reachability(access: DeployConfig['access']): string {
  return access === 'iam'
    ? style.dim(
        '  access:   iam — the platform admits only callers holding its own identity\n' +
          '            token. No agent harness can mint one; use --access public with an\n' +
          '            authorization block if a remote MCP client has to reach this.',
      )
    : style.dim(
        '  access:   public — the platform lets requests through and this endpoint\n' +
          '            authenticates them. The bearer token is what protects it.',
      );
}

/** Ask the deployed endpoint whether it came up. */
export async function healthLine(url: string): Promise<string> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return warn(`the endpoint answered /health with ${response.status}`);

    // Asked anonymously, so it reports that the revision is up and nothing
    // about what it serves — the profile list is behind the token now.
    // `lanes link outputs` holds one and prints the rest.
    const body = (await response.json()) as { profiles?: string[] };
    return ok(
      body.profiles
        ? `healthy — serving ${body.profiles.join(', ')}`
        : 'healthy — run `lanes link outputs` with this profile and target for what it serves',
    );
  } catch {
    // A cold start plus a database connect can outrun a short probe, and
    // `access: iam` makes /health unreachable from here by design. Neither is a
    // failed deploy.
    return warn('could not reach /health from here — with access: iam that is expected');
  }
}
