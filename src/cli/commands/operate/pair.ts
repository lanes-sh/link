import { randomBytes } from 'node:crypto';
import {
  ConfigError,
  PAIR_CERT_REF,
  PAIR_KEY_REF,
  PAIR_TOKEN_REF,
  loadWorkspaceProfiles,
  openTarget,
  type LoadedProfile,
  resolveWorkspaceRoot,
} from '#profile';
import type { ResolvedTarget } from '#profile';
import { deployedUrl } from '../../endpoint-url.ts';
import { ensureCertificate } from './pair-certificate.ts';
import { recordConfigChange } from '../../audit-change.ts';
import { ok, print, style } from '../../output.ts';
import type { SecretStore } from '#secrets';
import { openSecretStoreFor, type GlobalFlags } from '../../runtime.ts';

/**
 * `lanes link pair` — let the Lanes dashboard read this machine (ADR-063).
 *
 * Three things, and each is the operator's to decline. It installs a locally
 * trusted certificate, mints a credential that reads the whole workspace and
 * writes the owner's own data in it, and hands the browser a link carrying it.
 * None of that happens without being asked for, and none of it is implied by
 * `start`.
 *
 * **The credential is not read-only, since ADR-069.** It edits and deletes
 * memory, tasks, assets, skills and entities, in every profile the workspace
 * holds, and it still reaches no connection, token, policy rule, configuration
 * or vault value. That is a widening of something a year of notes calls a read,
 * so the paragraph this command prints says it before the operator answers —
 * and a token minted before that release gains it silently, which is the reason
 * saying it here is not decoration.
 *
 * **The certificate is the largest side effect any command in this CLI has.**
 * It is a persistent change to the machine's trust store, made by a CLI, and
 * ADR-053's precedent applies unchanged: offer it, name what it is, and stop if
 * declined. A run with nobody at the terminal is refused rather than assumed.
 *
 * **The token travels in a fragment.** `#pair=` is never sent to a server, so a
 * credential for a surface whose entire point is that Lanes cannot see it does
 * not end up in a Lanes access log, a proxy, or a referrer header.
 *
 * **A deployed workspace pairs too, and skips all of that** (ADR-064). The
 * certificate was the whole of the old refusal — installing one for an address
 * this machine does not answer on is meaningless — and it is the one piece a
 * deployed endpoint does not need, because the platform terminates TLS with a
 * certificate a browser already trusts. What remains is a token and an address.
 *
 * **It names a workspace, not a profile**, because that is what it pairs. The
 * surface it opens lists every connection and every profile the workspace holds,
 * and the credential it mints reads all of them — so asking which profile was
 * asking a question with no answer, and implying a per-profile pairing that does
 * not exist. `--profile` is still accepted, and picks the port when profiles
 * disagree about one.
 */

/**
 * Where the three pieces live in the credential store.
 *
 * Declared in `#profile` rather than here, because three components read these
 * names now and only one of them is the CLI — the server opens the read surface
 * with them and a deploy binds the token so the revision may read it. Importing
 * a *command* module for a string constant pulled the CLI's output and prompt
 * handling into the container's runtime graph. Re-exported because a year of
 * callers spell them from here.
 */
export { PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF };

/** Where the dashboard lives, overridable so `lanes dev` can pair against it. */
const DASHBOARD_URL = process.env['LANES_WEB_URL'] ?? 'https://lanes.sh';

export interface PairFlags extends GlobalFlags {
  /** Print the link for an existing pairing and change nothing. */
  readonly print?: boolean | undefined;
  /** Mint a fresh token, invalidating whatever a browser already holds. */
  readonly rotate?: boolean | undefined;
  /** Do not ask before installing mkcert. */
  readonly yes?: boolean | undefined;
}

export interface PairDeps {
  readonly which?: (binary: string) => string | null;
  readonly run?: (command: readonly string[]) => Promise<string | null>;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly interactive?: boolean;
}

export async function pair(flags: PairFlags, deps: PairDeps = {}): Promise<void> {
  const target = flags.target!;
  const root = resolveWorkspaceRoot();
  const resolved = await openTarget(root, target);
  const { loaded: profiles } = await loadWorkspaceProfiles(resolved.workspaceRoot);

  if (profiles.length === 0) {
    throw new ConfigError(
      `Workspace "${target}" holds no profiles, so there is no endpoint to pair.\n` +
        `  Create one with: lanes link profile add <name> --workspace ${target}`,
    );
  }

  // One endpoint serves every profile in a workspace, so they normally agree on
  // a port and the choice is not a choice. Where they do not, the ambiguity is
  // real and `--profile` is how it is settled — refused rather than guessed,
  // because pairing the wrong port produces a dashboard that says "not
  // connected" with everything working.
  const named = flags.profile
    ? profiles.find((one: LoadedProfile) => one.profile === flags.profile)
    : undefined;

  if (flags.profile && !named) {
    throw new ConfigError(
      `Workspace "${target}" has no profile "${flags.profile}".\n` +
        `  It holds: ${profiles.map((one: LoadedProfile) => one.profile).join(', ')}`,
    );
  }

  const ports = new Set(profiles.map((one: LoadedProfile) => one.config.instance.port));
  if (!named && ports.size > 1) {
    throw new ConfigError(
      `The profiles in "${target}" do not agree on a port, so it is not clear which endpoint to pair.\n` +
        profiles
          .map((one: LoadedProfile) => `    ${one.profile}  ${one.config.instance.port}`)
          .join('\n') +
        '\n  Name one: lanes link pair --profile <name>',
    );
  }

  const chosen = named ?? profiles[0]!;
  const host = chosen.config.instance.host;
  const credentials = await openSecretStoreFor(root, target);

  // A workspace that declares a deployment is paired over the address the
  // platform gave it, not over loopback — which is what `declared.deploy`
  // answers and what `instance.host` does not: a deployed revision takes its
  // host from the container's environment, so a profile bound to `127.0.0.1`
  // in config is still serving `0.0.0.0` on Cloud Run.
  if (resolved.declared.deploy) {
    await pairDeployed({ flags, target, chosen, root, credentials, deploy: resolved.declared.deploy });
    return;
  }

  if (!isLoopback(host)) {
    // Not deployed, and not on this machine either. There is no certificate
    // this command could install for an address this machine does not answer
    // on, and no platform URL to hand the browser instead.
    throw new ConfigError(
      `"${target}" is bound to ${host}, which is neither loopback nor a deployment.\n` +
        '  Pairing reaches an endpoint on *this* machine, or one `lanes link deploy` put\n' +
        '  somewhere with an address of its own.',
    );
  }

  const readPort = chosen.config.instance.port + 1;

  // `127.0.0.1` rather than `instance.host`, even though `localhost` and `::1`
  // are equally loopback and equally covered by the certificate. It is one
  // address for one machine, and the browser has to agree with `open.ts` about
  // which spelling it is: two pairings of the same endpoint under two names
  // would be two entries in the switcher, both working, neither wrong.
  const address = `https://127.0.0.1:${readPort}`;

  if (flags.print === true) {
    const existing = await credentials.get(PAIR_TOKEN_REF);
    if (existing === null) throw new ConfigError('Not paired yet. Run: lanes link pair');
    print(pairingLink(existing, address));
    return;
  }

  const certificate = await ensureCertificate(credentials, flags, deps);

  const rotating = flags.rotate === true;
  const existing = rotating ? null : await credentials.get(PAIR_TOKEN_REF);
  const token = existing ?? `llp_${randomBytes(32).toString('base64url')}`;
  if (existing === null) await credentials.set(PAIR_TOKEN_REF, token);

  // The token itself never goes in, obviously. What is worth recording is that
  // a credential reading the whole workspace now exists, and when — and for a
  // rotation, that whatever a browser was holding stopped working at that
  // moment.
  if (existing === null) {
    await recordConfigChange(chosen.config, root, target, {
      capability: rotating ? 'config.pair.rotate' : 'config.pair.mint',
      scope: target,
      arguments: { readPort, certificate },
    });
  }

  print(ok(certificate === 'reused' ? 'certificate already installed' : 'certificate installed'));
  if (rotating) {
    print(style.dim('      The previous pairing link no longer works. Re-open the new one.'));
  }
  print('');
  print(ok(`the dashboard may now read ${style.bold(address)}`));
  print('');
  print(pairingLink(token, address));
  print('');
  print(
    style.dim(
      '      Open that in a browser on this machine. The token is in the URL fragment,\n' +
        '      so it never reaches a Lanes server.\n' +
        '      It reads every connection, profile and audit entry in this workspace, and\n' +
        '      can edit and delete your memory, tasks, files, skills and entities in every\n' +
        '      profile here. It changes no connection, token, policy rule or configuration,\n' +
        '      and never reads a vault value.\n' +
        '      Take it back with: lanes link pair --rotate\n' +
        '\n' +
        `      The endpoint has to be running: lanes link start --workspace ${target}`,
    ),
  );
}

/**
 * Pairing a workspace that lives somewhere with an address of its own (ADR-064).
 *
 * The half of `pair` that is *not* shared with loopback is the certificate, and
 * that was always the whole of the old refusal: installing one for an address
 * this machine does not answer on is meaningless, and it is still meaningless.
 * What was never the thing being refused is the credential and the address —
 * the endpoint terminates TLS with a certificate a browser already trusts, so
 * the two pieces that remain are a token and a URL.
 *
 * So there is no `mkcert` here, nothing is installed, and nothing is asked. The
 * command writes one secret and prints a link.
 */
async function pairDeployed(input: {
  flags: PairFlags;
  target: string;
  chosen: LoadedProfile;
  root: string;
  credentials: SecretStore;
  deploy: NonNullable<ResolvedTarget['declared']['deploy']>;
}): Promise<void> {
  const { flags, target, chosen, root, credentials } = input;

  // `deployedUrl` asks the platform where the service ended up and degrades to
  // null for every reason that is not this command's business — no driver, not
  // deployed yet, no credentials for the project. A link with no address in it
  // reads nothing, so this refuses rather than printing half of one.
  const mcpUrl = await deployedUrl(input.deploy);
  if (mcpUrl === null) {
    throw new ConfigError(
      `Could not find the address of "${target}".\n` +
        '  The service may not be deployed yet, or the platform CLI may not be signed in.\n' +
        `  Check it with: lanes link outputs --workspace ${target}`,
    );
  }

  // The read surface answers on the endpoint's own origin, beside `/mcp` rather
  // than on a port of its own — Cloud Run routes exactly one.
  const endpoint = mcpUrl.replace(/\/mcp$/, '');

  if (flags.print === true) {
    const existing = await credentials.get(PAIR_TOKEN_REF);
    if (existing === null || existing === '') {
      throw new ConfigError(`Not paired yet. Run: lanes link pair --workspace ${target}`);
    }
    print(pairingLink(existing, endpoint));
    return;
  }

  const rotating = flags.rotate === true;
  const held = rotating ? null : await credentials.get(PAIR_TOKEN_REF);

  // An empty string, not just a missing ref: `lanes link deploy` creates this
  // secret with no version so the revision's IAM binding has something to
  // attach to, and a secret that exists with no version reads back as null
  // here and as `unpaired` there. Either shape means nobody has paired yet.
  const existing = held === '' ? null : held;
  const token = existing ?? `llp_${randomBytes(32).toString('base64url')}`;
  if (existing === null) await credentials.set(PAIR_TOKEN_REF, token);

  if (existing === null) {
    await recordConfigChange(chosen.config, root, target, {
      capability: rotating ? 'config.pair.rotate' : 'config.pair.mint',
      scope: target,
      arguments: { endpoint },
    });
  }

  print(ok('no certificate needed — this endpoint already has one a browser trusts'));
  if (rotating) {
    print(style.dim('      The previous pairing link no longer works. Re-open the new one.'));
  }
  print('');
  print(ok(`the dashboard may now read ${style.bold(endpoint)}`));
  print('');
  print(pairingLink(token, endpoint));
  print('');
  print(
    style.dim(
      '      Open that in any browser, on any machine. The token is in the URL fragment,\n' +
        '      so it never reaches a Lanes server.\n' +
        '      It reads every connection, profile and audit entry in this workspace, and\n' +
        '      can edit and delete your memory, tasks, files, skills and entities in every\n' +
        '      profile here. It changes no connection, token, policy rule or configuration,\n' +
        '      and never reads a vault value.\n' +
        '      Take it back with:\n' +
        `        lanes link pair --workspace ${target} --rotate\n` +
        '\n' +
        '      A rotation takes up to five seconds to be refused, because the endpoint\n' +
        '      caches what it read rather than calling Secret Manager per request.',
    ),
  );
}

/**
 * The link the browser opens.
 *
 * The token rides in the fragment, which is never sent to a server — so a
 * credential for a surface whose entire point is that Lanes cannot see this
 * data does not land in a Lanes access log, a proxy, or a referrer header. The
 * address rides beside it for the same reason and one more: it is the only
 * thing telling the page which of several paired endpoints this link is for,
 * and a query parameter would put a workspace's public address in that log.
 *
 * **A loopback link carries its address too**, and the parameter is required so
 * that it cannot quietly stop. It used to be omitted here on the reasoning that
 * loopback is derivable — and it is not: the read listener sits one port above
 * whatever `instance.port` says, so an endpoint on any port but the default
 * printed a link the dashboard then read at `7338`, reported unreachable, and
 * gave no way to correct. The page still treats a link with no `at=` as
 * loopback on the default port, because every link minted before this is that
 * shape.
 *
 * Exported for `pair.test.ts` and for nothing else. The whole of the defect
 * above was a shape nothing asserted on, in a command whose output no test
 * reads, so the fix is not worth much without something that fails when the
 * address goes missing again.
 */
export function pairingLink(token: string, endpoint: string): string {
  return `${DASHBOARD_URL}/dashboard/link#pair=${token}&at=${encodeURIComponent(endpoint)}`;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
