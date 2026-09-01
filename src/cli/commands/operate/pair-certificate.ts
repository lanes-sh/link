import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, PAIR_CERT_REF, PAIR_KEY_REF } from '#profile';
import type { SecretStore } from '#secrets';
import { print, style, warn } from '../../output.ts';
import { confirm, isInteractive } from '../../prompt.ts';
import type { PairDeps, PairFlags } from './pair.ts';

/**
 * Making a loopback address one this machine's browsers will trust.
 *
 * Split from `./pair.ts` because it is the half of pairing that only loopback
 * has. A deployed endpoint terminates TLS with a certificate a browser already
 * trusts, so none of this runs for one — and keeping it beside the command made
 * a file most of which did not apply to half its callers.
 *
 * It is also the largest side effect any command in this CLI has: a persistent
 * change to the machine's trust store, made by a CLI. That is why everything
 * here asks first, and why a run with nobody at the terminal is refused rather
 * than assumed.
 */

/** The names the certificate has to cover. All three are this machine. */
const HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * A certificate a browser on this machine will accept.
 *
 * mkcert and nothing else, deliberately. It is the one tool that installs into
 * the system trust store *and* Firefox's separate NSS store, across macOS,
 * Linux and Windows — and a self-signed certificate this command generated
 * itself would fail in the browser with an error the page cannot read, which is
 * the worst of both: the work is done and the feature does not work.
 */
export async function ensureCertificate(
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
