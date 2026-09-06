import { LANES_SCHEME, lanesWorkspaceFrom } from '#deployments/adapters/lanes.ts';
import { ControlAssertionVerifier } from './assertion.ts';
import type { ControlDeps } from './routes.ts';

/**
 * Turning the control surface on.
 *
 * `ServerOptions.control` existed, `serve()` dispatched on it, and
 * `ControlAssertionVerifier` was written and tested — and nothing anywhere
 * constructed either. Every control test called `controlRoutes` directly with a
 * stub verifier, so the surface was green and unreachable at the same time.
 * This is the composition root that was missing.
 *
 * **Absent is the default and the common case.** A local bind and a self-hosted
 * deploy pass no control deps, which is what keeps ADR-007's "a running instance
 * never mutates its own configuration" literally true for them. Only a
 * Lanes-managed runtime sets these, and it is `--no-allow-unauthenticated` with
 * the API's service account as the only caller IAM admits.
 */

/** The API's public key, in the SPKI PEM `openssl` prints. */
const PUBLIC_KEY = 'LANES_CONTROL_PUBLIC_KEY';
const ISSUER = 'LANES_CONTROL_ISSUER';
const AUDIENCE = 'LANES_CONTROL_AUDIENCE';

/**
 * SPKI PEM to the DER bytes `importKey` wants.
 *
 * Tolerant of how the key arrives, for the reason `oauth-jwt/key.ts` gives about
 * its own: a value pasted through an environment variable often carries literal
 * `\n` where a file carries real newlines, and both are the same key.
 */
function derFrom(pem: string): Uint8Array {
  const body = pem
    .replaceAll('\\n', '\n')
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index);
  return der;
}

async function publicKeyFrom(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'spki',
      derFrom(pem) as unknown as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch (cause) {
    // At boot rather than at the first request. A revision that started with an
    // unusable key would refuse every control call with the same "no" a forged
    // assertion gets, which in a log is indistinguishable from an attack.
    throw new Error(
      `${PUBLIC_KEY} is not an RSA public key in SPKI PEM form. ` +
        'Print one with `openssl rsa -pubout`.',
      { cause },
    );
  }
}

export async function controlDepsFrom(
  env: Record<string, string | undefined>,
): Promise<Omit<ControlDeps, 'log'> | undefined> {
  const pem = env[PUBLIC_KEY];
  // The key is the switch. A `lanes://` root alone does not turn control on:
  // the CLI addresses a managed workspace by that root too, and a runtime that
  // mounted control because of where its bytes live would be turning a storage
  // decision into an authorisation one.
  if (!pem) return undefined;

  const issuer = env[ISSUER];
  const audience = env[AUDIENCE];
  // Both, or neither. The audience is this service's own URL and the issuer is
  // the API's, and both carry the environment (ADR-072) — defaulting either
  // would let a stage runtime accept a prod-signed assertion, which is the one
  // thing separating the environments is for.
  if (!issuer) throw new Error(`${PUBLIC_KEY} is set but ${ISSUER} is not.`);
  if (!audience) throw new Error(`${PUBLIC_KEY} is set but ${AUDIENCE} is not.`);

  const root = env['LANES_LINK_HOME'] ?? '';
  if (!root.startsWith(LANES_SCHEME)) {
    throw new Error(
      `${PUBLIC_KEY} is set, so this runtime serves a managed workspace — but ` +
        `LANES_LINK_HOME is ${JSON.stringify(root)}, not ${LANES_SCHEME}<workspace-id>.`,
    );
  }

  return {
    workspace: lanesWorkspaceFrom(root),
    verifier: new ControlAssertionVerifier({
      publicKey: await publicKeyFrom(pem),
      issuer,
      audience,
    }),
  };
}
