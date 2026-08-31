import { beforeAll, describe, expect, test } from 'bun:test';
import { AssertionVerifier } from './assertion.ts';

/**
 * Believing lanes.sh about who is at the browser.
 *
 * Signed with a real key pair rather than stubbed, because every check here is
 * about a token somebody else could have written. A double that returns "valid"
 * would exercise the branches and prove nothing about the one property this
 * file exists for.
 *
 * The negative cases are the file. A verifier that accepts a good token and
 * nothing else is the whole requirement; each `expect(…).toBeNull()` below
 * corresponds to a way an endpoint could be made to believe the wrong person.
 */

const ISSUER = 'https://api.example.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = 'https://link.example.com/mcp';
const KID = 'a-key-id';

let keys: CryptoKeyPair;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A token as the API would mint it, with anything overridden for a test. */
async function assertion(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signWith?: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body =
    `${encode({ alg: 'RS256', typ: 'JWT', kid: KID, ...header })}.` +
    `${encode({
      iss: ISSUER,
      aud: RESOURCE,
      sub: 'FIREBASEUID000000000000000000',
      email: 'someone@example.com',
      nonce: 'a-nonce',
      iat: now,
      exp: now + 60,
      ...claims,
    })}`;

  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    signWith ?? keys.privateKey,
    new TextEncoder().encode(body),
  );

  return `${body}.${Buffer.from(signature).toString('base64url')}`;
}

type Call = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function verifier(overrides: { fetch?: Call; now?: () => number } = {}): AssertionVerifier {
  return new AssertionVerifier({
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    fetch: overrides.fetch ?? (async () => Response.json(jwks)),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

const EXPECTED = { audience: RESOURCE, nonce: 'a-nonce' };

describe('a token the API signed', () => {
  test('names the person, prefixed so a profile can hold the subject', async () => {
    const verified = await verifier().verify(await assertion(), EXPECTED);

    expect(verified?.subject).toBe('lanes:FIREBASEUID000000000000000000');
    expect(verified?.email).toBe('someone@example.com');
  });

  test('an already-prefixed subject is not prefixed twice', async () => {
    // The API may reasonably sign either. Doing this in one place means the
    // client and the server cannot disagree about what a subject looks like.
    const verified = await verifier().verify(await assertion({ sub: 'lanes:ABC123' }), EXPECTED);

    expect(verified?.subject).toBe('lanes:ABC123');
  });
});

describe('a token nobody should believe', () => {
  test('signed by a different key', async () => {
    const impostor = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;

    expect(await verifier().verify(await assertion({}, {}, impostor.privateKey), EXPECTED)).toBeNull();
  });

  test('with the payload edited after signing', async () => {
    const [header, , signature] = (await assertion()).split('.');
    const now = Math.floor(Date.now() / 1000);
    const swapped = encode({
      iss: ISSUER, aud: RESOURCE, sub: 'SOMEBODYELSE', nonce: 'a-nonce', iat: now, exp: now + 60,
    });

    expect(await verifier().verify(`${header}.${swapped}.${signature}`, EXPECTED)).toBeNull();
  });

  test('claiming alg none, which is the oldest way to skip the signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      `${encode({ alg: 'none', kid: KID })}.` +
      `${encode({ iss: ISSUER, aud: RESOURCE, sub: 'X', nonce: 'a-nonce', iat: now, exp: now + 60 })}.`;

    expect(await verifier().verify(unsigned, EXPECTED)).toBeNull();
  });

  test('minted for somebody else’s endpoint', async () => {
    // The confused-deputy case. The signature is genuine and the person is
    // real; the only thing wrong is that the assertion was for another
    // resource, and this check is the only thing that notices.
    const other = await assertion({ aud: 'https://someone-else.example.com/mcp' });

    expect(await verifier().verify(other, EXPECTED)).toBeNull();
  });

  test('carrying a nonce this endpoint did not mint', async () => {
    expect(await verifier().verify(await assertion({ nonce: 'a-different-nonce' }), EXPECTED)).toBeNull();
  });

  test('signed by an issuer we do not trust', async () => {
    expect(await verifier().verify(await assertion({ iss: 'https://evil.example' }), EXPECTED)).toBeNull();
  });

  test('that has expired', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await assertion({ iat: now - 600, exp: now - 300 });

    expect(await verifier().verify(stale, EXPECTED)).toBeNull();
  });

  test('whose own lifetime is longer than a redirect', async () => {
    // Checked here as well as at the issuer. A deployment that widened its
    // expiry would turn a redirect-scoped assertion into a bearer credential
    // sitting in a browser history, and this endpoint is what lives with that.
    const now = Math.floor(Date.now() / 1000);
    const long = await assertion({ iat: now, exp: now + 86_400 });

    expect(await verifier().verify(long, EXPECTED)).toBeNull();
  });

  test('signed with a key id that is not published', async () => {
    expect(await verifier().verify(await assertion({}, { kid: 'not-published' }), EXPECTED)).toBeNull();
  });

  test('that is not three parts', async () => {
    expect(await verifier().verify('nonsense', EXPECTED)).toBeNull();
  });
});

describe('the key set', () => {
  test('is fetched once and reused', async () => {
    let fetches = 0;
    const one = verifier({
      fetch: async () => {
        fetches += 1;
        return Response.json(jwks);
      },
    });

    await one.verify(await assertion(), EXPECTED);
    await one.verify(await assertion(), EXPECTED);

    expect(fetches).toBe(1);
  });

  test('a key id that is not in the cache refetches, which is what rotation looks like', async () => {
    // The real sequence: the cache is warm and correct, the API publishes a new
    // key, and a token signed with it arrives before the cache lapses. Without
    // the refetch every endpoint refuses until its cache times out.
    const rotated = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const rotatedJwk = await crypto.subtle.exportKey('jwk', rotated.publicKey);

    let fetches = 0;
    const one = verifier({
      fetch: async () => {
        fetches += 1;
        return Response.json(
          fetches === 1
            ? jwks
            : { keys: [...jwks.keys, { ...rotatedJwk, kid: 'the-next-key', alg: 'RS256' }] },
        );
      },
    });

    expect(await one.verify(await assertion(), EXPECTED)).not.toBeNull();
    expect(fetches).toBe(1);

    const next = await assertion({}, { kid: 'the-next-key' }, rotated.privateKey);
    expect(await one.verify(next, EXPECTED)).not.toBeNull();
    expect(fetches).toBe(2);
  });

  test('a key id nobody publishes does not refetch on every call', async () => {
    // The other half of the rule above. A token naming a key that does not
    // exist is what a flood looks like, and answering each one with a round
    // trip to the API would make this endpoint the amplifier.
    let fetches = 0;
    const one = verifier({
      fetch: async () => {
        fetches += 1;
        return Response.json(jwks);
      },
    });

    await one.verify(await assertion(), EXPECTED);
    await one.verify(await assertion({}, { kid: 'invented' }), EXPECTED);
    await one.verify(await assertion({}, { kid: 'invented' }), EXPECTED);

    expect(fetches).toBeLessThanOrEqual(2);
  });

  test('an unreachable JWKS refuses rather than admitting anything', async () => {
    const one = verifier({ fetch: async () => new Response('nope', { status: 503 }) });

    expect(await one.verify(await assertion(), EXPECTED)).toBeNull();
  });
});
