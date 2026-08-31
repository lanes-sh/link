import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  loadWorkspaceProfiles,
  openTarget,
  type LoadedProfile,
  resolveWorkspaceRoot,
} from '#profile';
import { ok, print, style, warn } from '../../output.ts';
import { confirm, isInteractive } from '../../prompt.ts';
import type { SecretStore } from '#secrets';
import { openSecretStoreFor, type GlobalFlags } from '../../runtime.ts';

/**
 * `lanes link pair` — let the Lanes dashboard read this machine (ADR-063).
 *
 * Three things, and each is the operator's to decline. It installs a locally
 * trusted certificate, mints a credential that reads the whole workspace, and
 * hands the browser a link carrying it. None of that happens without being
 * asked for, and none of it is implied by `start`.
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
 * Underscores, not dots. A secret reference is `[a-z0-9_-]` separated by `/`
 * (see `isValidSecretRef`), and that is not arbitrary: these names become
 * Secret Manager entries on a deployed workspace, and Google allows no dots
 * there either. `workspace/pair.cert` was refused at the moment somebody first
 * ran the command.
 */
export const PAIR_TOKEN_REF = 'workspace/pair_token';
export const PAIR_CERT_REF = 'workspace/pair_cert';
export const PAIR_KEY_REF = 'workspace/pair_key';

/** Where the dashboard lives, overridable so `lanes dev` can pair against it. */
const DASHBOARD_URL = process.env['LANES_WEB_URL'] ?? 'https://lanes.sh';

/** The names the certificate has to cover. All three are this machine. */
const HOSTS = ['127.0.0.1', 'localhost', '::1'];

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

  if (!isLoopback(host)) {
    // A deployed endpoint is already reachable by URL and needs none of this.
    // Pairing one would mean installing a certificate for an address this
    // machine does not answer on.
    throw new ConfigError(
      `"${target}" is bound to ${host}, not loopback, so there is nothing here to pair.\n` +
        '  Pairing exists so a browser can read an endpoint on *this* machine.',
    );
  }

  const readPort = chosen.config.instance.port + 1;
  const credentials = await openSecretStoreFor(chosen.config, root, target);

  if (flags.print === true) {
    const existing = await credentials.get(PAIR_TOKEN_REF);
    if (existing === null) throw new ConfigError('Not paired yet. Run: lanes link pair');
    print(link(existing));
    return;
  }

  const certificate = await ensureCertificate(credentials, flags, deps);

  const rotating = flags.rotate === true;
  const existing = rotating ? null : await credentials.get(PAIR_TOKEN_REF);
  const token = existing ?? `llp_${randomBytes(32).toString('base64url')}`;
  if (existing === null) await credentials.set(PAIR_TOKEN_REF, token);

  print(ok(certificate === 'reused' ? 'certificate already installed' : 'certificate installed'));
  if (rotating) {
    print(style.dim('      The previous pairing link no longer works. Re-open the new one.'));
  }
  print('');
  print(ok(`the dashboard may now read ${style.bold(`https://127.0.0.1:${readPort}`)}`));
  print('');
  print(link(token));
  print('');
  print(
    style.dim(
      '      Open that in a browser on this machine. The token is in the URL fragment,\n' +
        '      so it never reaches a Lanes server.\n' +
        '      It reads every connection, profile and audit entry in this workspace, and\n' +
        '      can change nothing. Take it back with: lanes link pair --rotate\n' +
        '\n' +
        `      The endpoint has to be running: lanes link start --workspace ${target}`,
    ),
  );
}

function link(token: string): string {
  return `${DASHBOARD_URL}/dashboard/link#pair=${token}`;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * A certificate a browser on this machine will accept.
 *
 * mkcert and nothing else, deliberately. It is the one tool that installs into
 * the system trust store *and* Firefox's separate NSS store, across macOS,
 * Linux and Windows — and a self-signed certificate this command generated
 * itself would fail in the browser with an error the page cannot read, which is
 * the worst of both: the work is done and the feature does not work.
 */
async function ensureCertificate(
  credentials: SecretStore,
  flags: PairFlags,
  deps: PairDeps,
): Promise<'reused' | 'installed'> {
  const held =
    (await credentials.get(PAIR_CERT_REF)) !== null &&
    (await credentials.get(PAIR_KEY_REF)) !== null;

  if (held && flags.rotate !== true) return 'reused';

  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const run = deps.run ?? runCommand;

  let mkcert = which('mkcert');
  if (!mkcert) mkcert = await installMkcert(flags, deps, which, run);

  // Installs the local CA if it is not already there, and says nothing if it
  // is. This is the step that touches the trust store, and it has already been
  // consented to by the time it runs.
  const installed = await run([mkcert, '-install']);
  if (installed !== null) {
    throw new ConfigError(`mkcert -install failed.\n${installed || '  It said nothing.'}`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'lanes-pair-'));
  try {
    const certPath = join(scratch, 'cert.pem');
    const keyPath = join(scratch, 'key.pem');

    const failed = await run([mkcert, '-cert-file', certPath, '-key-file', keyPath, ...HOSTS]);
    if (failed !== null) {
      throw new ConfigError(`mkcert failed to issue a certificate.\n${failed || '  It said nothing.'}`);
    }

    // Into the credential store rather than left on disk. The private key is a
    // secret by any reading, and the store is the one place in a workspace that
    // is encrypted at rest.
    await credentials.set(PAIR_CERT_REF, await readFile(certPath, 'utf8'));
    await credentials.set(PAIR_KEY_REF, await readFile(keyPath, 'utf8'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return 'installed';
}

async function installMkcert(
  flags: PairFlags,
  deps: PairDeps,
  which: (binary: string) => string | null,
  run: (command: readonly string[]) => Promise<string | null>,
): Promise<string> {
  const line = 'brew install mkcert';
  const brew = which('brew');

  if (!brew) {
    // The one path where this command cannot finish the job, so it hands over
    // the whole of it rather than half.
    throw new ConfigError(
      'Pairing needs mkcert, which issues a certificate this machine\'s browsers trust.\n' +
        `  With Homebrew: ${line}\n` +
        '  Otherwise: https://github.com/FiloSottile/mkcert#installation\n' +
        '  Then run "lanes link pair" again.',
    );
  }

  print(warn('pairing needs mkcert, and it is not installed'));
  print(
    style.dim(
      '  It issues a certificate for 127.0.0.1 that this machine trusts, which is what\n' +
        '  lets a page on lanes.sh read your endpoint at all. Safari will not fetch\n' +
        '  http://127.0.0.1 from an https page, and offers no way to allow it.\n' +
        '\n' +
        '  This installs a local certificate authority into your system trust store.\n' +
        `  ${line}`,
    ),
  );

  if (flags.yes !== true) {
    if (!(deps.interactive ?? isInteractive())) {
      throw new ConfigError(
        'Nothing here can answer a prompt, and installing a certificate authority because\n' +
          '  nobody was there to say no is the wrong way to resolve that.\n' +
          `  Run "${line}" yourself, or pass --yes.`,
      );
    }
    if (!(await (deps.confirm ?? ((question: string) => confirm(question)))('Install it now?'))) {
      throw new ConfigError(`Not paired. When you want it: ${line}`);
    }
  }

  const failed = await run([brew, 'install', 'mkcert']);
  if (failed !== null) throw new ConfigError(`${line} failed.\n${failed || '  It said nothing.'}`);

  const found = which('mkcert');
  if (!found) throw new ConfigError(`${line} reported success but mkcert is still not on PATH.`);
  return found;
}

/** Runs it. Null on success; whatever it said on failure. */
async function runCommand(command: readonly string[]): Promise<string | null> {
  const spawned = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([spawned.exited, new Response(spawned.stderr).text()]);
  return code === 0 ? null : stderr.trim();
}
