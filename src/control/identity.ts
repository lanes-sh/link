import { LANES_SCHEME, type TokenSource } from '#deployments/adapters/lanes.ts';

/**
 * How a managed runtime proves who it is to the Lanes API.
 *
 * This is the return leg of `./boot.ts`. That one verifies the statement the
 * API makes about a person so this runtime will act on it; this one makes a
 * statement about *itself* so it may read the bytes of the workspace it serves.
 *
 * **Why it needs one at all.** A managed workspace's storage is
 * `lanes://<workspace-id>`, which `#deployments/adapters/lanes.ts` opens through
 * `/v1/workspaces/{id}/link/files` — the same route the CLI and the dashboard
 * use, so every byte passes the single place the storage quota is counted. That
 * route knew two credentials and neither fitted: an `lfk_` key is refused there
 * outright because it is an agent, and a Firebase ID token is a person in a
 * browser. Without this the first read of `lanes-link.yaml` throws and the
 * runtime never finishes booting, which is exactly what was happening.
 *
 * **The assertion names one workspace.** A Google service-account identity token
 * would have been less code and names the *service*, so a copy of one reads
 * every tenant's files. This names the tenant, and the API refuses it anywhere
 * else. In a process serving many workspaces that is the difference between one
 * leaked token and all of them.
 *
 * **Not the same key as anything else here.** `LANES_CONTROL_PUBLIC_KEY`
 * verifies the API to us and `LINK_ASSERTION_*` tells an endpoint who is at a
 * browser. Three statements, three audiences; a key that satisfied two verifiers
 * would let a statement minted for one purpose be replayed for the other.
 */

/** The private half, PKCS#8 PEM. Its presence is what turns this on. */
const PRIVATE_KEY = 'LANES_RUNTIME_PRIVATE_KEY';

/** Who we claim to be. Must match the API's `LINK_RUNTIME_ISSUER` exactly. */
const ISSUER = 'LANES_RUNTIME_ISSUER';

/**
 * How long an assertion lives.
 *
 * Sixty seconds, the same as the one coming the other way, and for the same
 * reason: these are minted per call against a service in the same region, so
 * anything longer is a token worth stealing rather than a token worth having.
 * The API caps at two minutes whatever this says.
 */
const LIFETIME_SECONDS = 60;

/** What the API knows a runtime by. Fixed on both sides; see `link_runtime.py`. */
export const RUNTIME_SUBJECT = 'lanes-link:runtime';

function base64url(bytes: Uint8Array | string): string {
  const raw =
    typeof bytes === 'string' ? bytes : String.fromCharCode(...(bytes as unknown as number[]));
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * PKCS#8 PEM to the DER bytes `importKey` wants.
 *
 * Tolerant of literal `\n`, for the reason `./boot.ts` gives about the public
 * half: a PEM is multi-line and most ways of setting an environment variable
 * are not, so it arrives escaped roughly as often as not, and both spellings
 * are the same key.
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

async function privateKeyFrom(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      derFrom(pem) as unknown as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (cause) {
    // At boot rather than at the first config read. A revision that started
    // with an unusable key would fail every read with an error about storage,
    // which is a long way from the variable that is actually wrong.
    throw new Error(
      `${PRIVATE_KEY} is not an RSA private key in PKCS#8 PEM form. ` +
        'Print one with `openssl genpkey -algorithm RSA`.',
      { cause },
    );
  }
}

export interface RuntimeTokensOptions {
  readonly key: CryptoKey;
  readonly issuer: string;
  /** Where the API is. The assertion's audience, so a stage token is not a prod one. */
  readonly audience: string;
  /** Injected by tests so the claim set is checkable. */
  readonly now?: () => number;
}

/**
 * A `TokenSource` that mints one assertion per call.
 *
 * Not cached. A cache would be keyed by workspace and would have to expire
 * before the API's leeway does, which is more state than signing costs: this is
 * one RSA operation against a key already imported, on a path that runs when a
 * generation opens rather than per request.
 */
export function runtimeTokens(options: RuntimeTokensOptions): TokenSource {
  return {
    async token(workspace: string): Promise<string> {
      const issuedAt = Math.floor((options.now?.() ?? Date.now()) / 1000);

      const header = { alg: 'RS256', typ: 'JWT' };
      const claims = {
        iss: options.issuer,
        aud: options.audience,
        sub: RUNTIME_SUBJECT,
        // The whole reason this is per workspace. The API refuses it against
        // any other, so a serving process cannot read a neighbour's bytes even
        // by mistake.
        workspace,
        iat: issuedAt,
        exp: issuedAt + LIFETIME_SECONDS,
      };

      const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        options.key,
        new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
      );
      return `${signingInput}.${base64url(new Uint8Array(signature))}`;
    },
  };
}

/**
 * Build one from the environment, or nothing when this is not a managed runtime.
 *
 * Absent is the default and the common case, exactly as it is for the control
 * surface: a local bind and a self-hosted deploy have their bytes on a disk or
 * in their own bucket and never speak to `api.lanes.sh` about storage at all.
 */
export async function runtimeTokensFrom(
  env: Record<string, string | undefined>,
  apiUrl: string,
): Promise<TokenSource | undefined> {
  const pem = env[PRIVATE_KEY];
  if (!pem) {
    const root = env['LANES_LINK_HOME'] ?? '';
    if (root.startsWith(LANES_SCHEME)) {
      // Refused rather than left to fail at the first read. A `lanes://` root
      // with no key is a runtime that will throw "No credential is registered"
      // on `lanes-link.yaml`, which reads as a storage fault three components
      // away from the variable that is missing.
      throw new Error(
        `LANES_LINK_HOME is ${JSON.stringify(root)}, so this runtime's bytes live with ` +
          `Lanes — but ${PRIVATE_KEY} is not set, so it has nothing to present to the API.`,
      );
    }
    return undefined;
  }

  const issuer = env[ISSUER];
  // Both, or neither, for the reason `./boot.ts` gives: the issuer carries the
  // environment (ADR-072), and defaulting it would let a stage runtime present
  // a statement prod accepts.
  if (!issuer) throw new Error(`${PRIVATE_KEY} is set but ${ISSUER} is not.`);

  return runtimeTokens({ key: await privateKeyFrom(pem), issuer, audience: apiUrl });
}
