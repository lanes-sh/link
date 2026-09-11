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
import { pairingGuidance, pairingLink } from './pairing-link.ts';

/**
 * `lanes link pair` — let the Lanes dashboard read this machine (ADR-063).
 *
 * Three things, and each is the operator's to decline. It installs a locally
 * trusted certificate, records that somebody opted this endpoint in, and hands
 * the browser a link carrying the address. None of that happens without being
 * asked for, and none of it is implied by `start`.
 *
 * **What it mints is a marker, not a credential, since ADR-079.** This docstring
 * said the opposite for a release: that the token "reads the whole workspace and
 * writes the owner's own data in it", which was true under ADR-069 and stopped
 * being true when the read surface started resolving a real bearer through the
 * endpoint's own authenticator. Nothing verifies `workspace/pair_token` now —
 * `server/read/open.ts` says so at the one place that still reads it — and its
 * only remaining job is that its existence is what decides whether the loopback
 * read port binds at all.
 *
 * So the credential question moved to whoever opens the link: they sign in with
 * Lanes and reach the profiles whose `members:` name them. `pairingGuidance()`
 * is the paragraph that says that to the operator, and it is the copy to keep
 * right — this one is for whoever edits the command.
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
 * **It names a workspace, not a profile**, because that is what it pairs. It
 * does not follow that it *reaches* every profile, and it no longer does: the
 * token opens an exchange, and what that hands back is a session naming the
 * person at the browser and the profiles whose `members:` name them back
 * (ADR-079). Asking which profile at mint time would still be a question with
 * no answer — the answer belongs to whoever opens the link, and is read then. `--profile` is still accepted, and picks the port when profiles
 * disagree about one *and a port is what the address is built from*. Deployed,
 * it is not: the platform assigns one address for the whole workspace, so the
 * flag decides nothing there and is not asked for. It was asked for, for one
 * release — the ports were compared before the deployment was, so a cloud
 * workspace whose profiles had been created on different days refused to pair
 * at all, and the flag that unblocked it produced the same link either way.
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
  /**
   * Where the platform put this workspace's service.
   *
   * Injected for the same reason `which` and `run` are: the deployed path
   * otherwise reaches a driver, a subprocess and a live project, and the
   * decisions worth asserting on here — that no port is consulted, that the
   * link carries the platform's address — are all upstream of that. Defaults
   * to asking the platform, which is what every real run does.
   */
  readonly address?: (
    deploy: NonNullable<ResolvedTarget['declared']['deploy']>,
  ) => Promise<string | null>;
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

  const named = flags.profile
    ? profiles.find((one: LoadedProfile) => one.profile === flags.profile)
    : undefined;

  if (flags.profile && !named) {
    throw new ConfigError(
      `Workspace "${target}" has no profile "${flags.profile}".\n` +
        `  It holds: ${profiles.map((one: LoadedProfile) => one.profile).join(', ')}`,
    );
  }

  // **A profile naming nobody is now a profile nobody can open.** It always was
  // over MCP — empty `members:` is deny, not allow — but the dashboard used to
  // read every profile regardless, so this is the first release where an
  // untouched one disappears from a page its owner was reading. Said at mint
  // time, where it can still be fixed before anybody opens the link, rather
  // than discovered as an empty list.
  const unreachable = profiles
    .filter((one: LoadedProfile) => one.config.members.length === 0)
    .map((one: LoadedProfile) => one.profile);

  if (unreachable.length > 0) {
    print(
      style.dim(
        `warn  ${unreachable.join(', ')} ${unreachable.length === 1 ? 'lists' : 'list'} no members, so nobody reaches ${unreachable.length === 1 ? 'it' : 'them'}.\n` +
          `      Put yourself on one with: lanes link profile members add --me --profile <name>`,
      ),
    );
  }

  // A workspace that declares a deployment is paired over the address the
  // platform gave it, not over loopback — which is what `declared.deploy`
  // answers and what `instance.host` does not: a deployed revision takes its
  // host from the container's environment, so a profile bound to `127.0.0.1`
  // in config is still serving `0.0.0.0` on Cloud Run.
  //
  // **Decided before any port is looked at**, because on this path there is no
  // port to look at. The address comes from the platform, one service answers
  // for the whole workspace, and `instance.port` reaches neither. Asked after
  // the ports were compared, this refused a perfectly unambiguous pairing for
  // two profiles that had merely been created on different days — and the
  // `--profile` it demanded settled nothing, since both answers produce the
  // same link. A question whose answer cannot change the outcome is not a
  // question.
  if (resolved.declared.deploy) {
    await pairDeployed({
      flags,
      target,
      chosen: named ?? profiles[0]!,
      root,
      credentials: await openSecretStoreFor(root, target),
      deploy: resolved.declared.deploy,
      address: deps.address ?? deployedUrl,
    });
    return;
  }

  // Loopback, where the port *is* the address. One endpoint serves every
  // profile in a workspace, so they normally agree on a port and the choice is
  // not a choice. Where they do not, the ambiguity is real and `--profile` is
  // how it is settled — refused rather than guessed, because pairing the wrong
  // port produces a dashboard that says "not connected" with everything
  // working.
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
    await recordConfigChange(chosen.config.instance.profile, root, target, {
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
  print(ok(`the dashboard may now sign in to ${style.bold(address)}`));
  print('');
  print(pairingLink(token, address));
  print('');
  print(
    style.dim(
      `${pairingGuidance()}\n` +
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
  address: (deploy: NonNullable<ResolvedTarget['declared']['deploy']>) => Promise<string | null>;
}): Promise<void> {
  const { flags, target, chosen, root, credentials } = input;

  // `deployedUrl`, unless a test named something else, asks the platform where
  // the service ended up and degrades to null for every reason that is not this
  // command's business — no driver, not deployed yet, no credentials for the
  // project. A link with no address in it reads nothing, so this refuses rather
  // than printing half of one.
  const mcpUrl = await input.address(input.deploy);
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
  // attach to, and a secret that exists with no version reads back as null both
  // here and in the endpoint. Either shape means nobody has paired yet, and
  // there it means the read port does not bind rather than that a request is
  // refused — nothing answers `unpaired`, which this said until ADR-079.
  const existing = held === '' ? null : held;
  const token = existing ?? `llp_${randomBytes(32).toString('base64url')}`;
  if (existing === null) await credentials.set(PAIR_TOKEN_REF, token);

  if (existing === null) {
    await recordConfigChange(chosen.config.instance.profile, root, target, {
      capability: rotating ? 'config.pair.rotate' : 'config.pair.mint',
      scope: target,
      arguments: { endpoint },
    });
  }

  print(ok('no certificate needed — this endpoint already has one a browser trusts'));
  print('');
  print(ok(`the dashboard may now sign in to ${style.bold(endpoint)}`));
  print('');
  print(pairingLink(token, endpoint));
  print('');
  print(style.dim(pairingGuidance()));
}


function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
