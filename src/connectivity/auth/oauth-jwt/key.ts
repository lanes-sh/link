import { z } from 'zod';

/**
 * The key half of RFC 7523: a private key on disk, and the assertion it signs.
 *
 * Split from `index.ts` because it is the only part with no I/O — no store, no
 * network — which is what makes the claim set and the signature testable
 * against a locally generated key rather than against a live token endpoint.
 *
 * Nothing here knows which vendor issued the key. The layout below is the one
 * every authorization server that accepts this grant ships, and the endpoint to
 * present the assertion at comes from the key file itself rather than from a
 * constant, so adding a second vendor is a manifest and no code.
 */

/**
 * The issued key file, as the vendor's console writes it.
 *
 * Parsed rather than trusted: the common mistake is pasting the *client* JSON —
 * the one with `installed` or `web` at the top level — which is a different
 * file with a different purpose and would otherwise fail much later, at the
 * token endpoint, as an unexplained 400.
 */
export const assertionKeySchema = z.object({
  /** Who the assertion is from. Also the address a resource is shared with. */
  client_email: z.string().min(1),
  /** PKCS#8 PEM. */
  private_key: z.string().min(1),
  /** Where the assertion is exchanged. Read from the file so no vendor is named here. */
  token_uri: z.url(),
  /** Names which key signed it, for a server holding more than one. */
  private_key_id: z.string().optional(),
});

export type AssertionKey = z.infer<typeof assertionKeySchema>;

export function parseAssertionKey(raw: string, ref: string): AssertionKey {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `The key at ${ref} is not JSON. It should be the whole file the console downloaded, pasted verbatim.`,
    );
  }

  const parsed = assertionKeySchema.safeParse(json);
  if (parsed.success) return parsed.data;

  // The two files are easy to confuse and the console offers both on adjacent
  // pages, so say which one is in hand rather than listing missing fields.
  const shape = json as Record<string, unknown> | null;
  if (shape && (shape['installed'] !== undefined || shape['web'] !== undefined)) {
    throw new Error(
      `The key at ${ref} is an OAuth *client* file, not an account key. That one is for the ` +
        'browser flow. The key needed here is downloaded from the account itself and has ' +
        '"private_key" in it.',
    );
  }

  throw new Error(
    `The key at ${ref} is missing ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}.`,
  );
}

/** JWT's own encoding: base64 with a URL-safe alphabet and no padding. */
function base64url(bytes: Uint8Array | string): string {
  const raw =
    typeof bytes === 'string'
      ? btoa(bytes)
      : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return raw.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * PKCS#8 PEM to the DER bytes `importKey` wants.
 *
 * Tolerant of how the key arrives: a console download carries real newlines, a
 * value pasted through an environment variable or a JSON string often carries
 * literal `\n` instead, and both are the same key. Rejecting the second would
 * be a failure whose cause is invisible in a terminal.
 */
function derFromPem(pem: string): Uint8Array {
  const body = pem
    .replaceAll('\\n', '\n')
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index);
  return der;
}

/** How long the assertion is good for. Kept short: it is minted per exchange. */
const ASSERTION_LIFETIME_SECONDS = 3600;

/**
 * Sign the assertion this grant exchanges for a token.
 *
 * `sub` is what makes one identity act as another, and it is present only when
 * the caller supplies one — an assertion carrying an empty `sub` is not the
 * same request as one carrying none, and servers treat it as malformed rather
 * than as absent.
 */
export async function signAssertion(input: {
  readonly key: AssertionKey;
  readonly scopes: readonly string[];
  /** The account to act as, where the key is only permitted to borrow one. */
  readonly subject?: string | undefined;
  /** Injected by tests so the claim set is checkable. */
  readonly now?: number;
}): Promise<string> {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(input.key.private_key_id ? { kid: input.key.private_key_id } : {}),
  };

  const claims = {
    iss: input.key.client_email,
    scope: input.scopes.join(' '),
    aud: input.key.token_uri,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    ...(input.subject ? { sub: input.subject } : {}),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    derFromPem(input.key.private_key) as unknown as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
  );

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
