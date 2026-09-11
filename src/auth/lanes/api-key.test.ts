import { beforeAll, describe, expect, test } from 'bun:test';
import { ApiKeyVerifier } from './api-key.ts';
import { AssertionVerifier } from './assertion.ts';

/**
 * Believing an API key the dashboard minted.
 *
 * Signed with a real key pair rather than stubbed, for the reason
 * `./assertion.test.ts` gives: every check here is about a token somebody else
 * could have written, and a double that returns "valid" would exercise the
 * branches and prove nothing.
 *
 * The two tests that matter most are in `a credential for the other purpose`.
 * An assertion and a key are signed by the same issuer, for the same audience,
 * naming the same person — the *only* thing separating a two-minute redirect
 * credential from a ninety-day one is that each verifier refuses the other's.
 * If those two ever go green by accident, a captured assertion becomes a
 * long-lived key and a key becomes a way through the consent flow.
 */

const ISSUER = 'https://api.example.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = 'https://link.example.com/mcp';
const KID = 'a-key-id';
const DAY = 24 * 60 * 60;

let keys: CryptoKeyPair;
let jwks: { keys: unknown[] };

async function generate(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

beforeAll(async () => {
  keys = await generate();
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A key as the API would mint one, with anything overridden for a test. */
async function key(
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
      email: 'ada.lovelace@example.com',
      kind: 'api_key',
      iat: now,
      exp: now + 90 * DAY,
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

function verifier(overrides: { fetch?: Call; now?: () => number } = {}): ApiKeyVerifier {
  return new ApiKeyVerifier({
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    fetch: overrides.fetch ?? (async () => Response.json(jwks)),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

const EXPECTED = { audience: RESOURCE };

describe('a key the API signed', () => {
  test('names the person, prefixed so a profile can hold the subject', async () => {
    const verified = await verifier().verify(await key(), EXPECTED);

    expect(verified?.subject).toBe('lanes:FIREBASEUID000000000000000000');
    expect(verified?.email).toBe('ada.lovelace@example.com');
  });

  test('needs no nonce, because it crosses no redirect', async () => {
    // The claim that binds an assertion to one authorization request has nothing
    // to bind to here: a key is presented on every request, forever.
    expect(await verifier().verify(await key(), EXPECTED)).not.toBeNull();
  });

  test('lives for ninety days without complaint', async () => {
    const later = Date.now() + 80 * DAY * 1000;
    const verified = await verifier({ now: () => later }).verify(await key(), EXPECTED);

    expect(verified).not.toBeNull();
  });
});

describe('a credential for the other purpose', () => {
  test('a key is refused where an assertion belongs', async () => {
    // Same issuer, same audience, same person, and a lifetime the assertion's
    // own ceiling would also catch — but this must fail on `kind`, because a key
    // minted with a short expiry would slip past that ceiling.
    const assertions = new AssertionVerifier({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetch: async () => Response.json(jwks),
    });

    const shortLived = await key({ nonce: 'a-nonce', exp: Math.floor(Date.now() / 1000) + 60 });

    expect(await assertions.verify(shortLived, { audience: RESOURCE, nonce: 'a-nonce' })).toBeNull();
  });

  test('an assertion is refused as a key', async () => {
    // An assertion carries no `kind`, and this verifier requires one. That
    // asymmetry is deliberate: see the comment in `./api-key.ts`.
    const asAssertion = await key({ kind: undefined, nonce: 'a-nonce' });

    expect(await verifier().verify(asAssertion, EXPECTED)).toBeNull();
  });

  test('an unknown kind is refused rather than treated as a key', async () => {
    expect(await verifier().verify(await key({ kind: 'something_else' }), EXPECTED)).toBeNull();
  });
});

describe('a key nobody should believe', () => {
  test('signed by a different key', async () => {
    const impostor = await generate();

    expect(await verifier().verify(await key({}, {}, impostor.privateKey), EXPECTED)).toBeNull();
  });

  test('minted for somebody else’s endpoint', async () => {
    // The confused-deputy case. A valid key, for a real person, naming an
    // audience that is not us.
    const elsewhere = await key({ aud: 'https://other.example.net/mcp' });

    expect(await verifier().verify(elsewhere, EXPECTED)).toBeNull();
  });

  test('an audience that merely starts with ours', async () => {
    const nearly = await key({ aud: `${RESOURCE}.evil.example.net` });

    expect(await verifier().verify(nearly, EXPECTED)).toBeNull();
  });

  test('from an issuer we were not told to trust', async () => {
    expect(await verifier().verify(await key({ iss: 'https://evil.example.net' }), EXPECTED)).toBeNull();
  });

  test('expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 10 * DAY;

    expect(await verifier().verify(await key({ iat: past - 60, exp: past }), EXPECTED)).toBeNull();
  });

  test('with no expiry at all', async () => {
    // An unbounded key is not a thing this endpoint accepts, and the check is
    // the lifetime ceiling rather than a separate rule: a missing `exp` reports
    // an infinite lifetime.
    expect(await verifier().verify(await key({ exp: undefined }), EXPECTED)).toBeNull();
  });

  test('claiming a lifetime past the ceiling', async () => {
    const now = Math.floor(Date.now() / 1000);
    const decade = await key({ iat: now, exp: now + 3650 * DAY });

    expect(await verifier().verify(decade, EXPECTED)).toBeNull();
  });

  test('with no subject', async () => {
    expect(await verifier().verify(await key({ sub: undefined }), EXPECTED)).toBeNull();
  });

  test('naming an algorithm we do not verify', async () => {
    // Pinned rather than read. `none` and HMAC-with-the-public-key both live here.
    expect(await verifier().verify(await key({}, { alg: 'none' }), EXPECTED)).toBeNull();
  });

  test('naming a key id that was never published', async () => {
    expect(await verifier().verify(await key({}, { kid: 'not-a-key' }), EXPECTED)).toBeNull();
  });

  test('when the key set cannot be fetched at all', async () => {
    const offline = verifier({ fetch: async () => new Response('nope', { status: 503 }) });

    expect(await offline.verify(await key(), EXPECTED)).toBeNull();
  });
});

describe('the key set', () => {
  test('an outage does not forget keys already fetched', async () => {
    // What keeps a verified endpoint working while the API is down. The first
    // call warms the cache; the second finds the fetch failing and must still
    // answer from what it already had.
    let calls = 0;
    const flaky: Call = async () => {
      calls += 1;
      return calls === 1 ? Response.json(jwks) : new Response('down', { status: 500 });
    };

    const one = verifier({ fetch: flaky });
    expect(await one.verify(await key(), EXPECTED)).not.toBeNull();

    // Forces a refetch by asking for a kid the warm cache does not hold, which
    // is the only path that reaches the network again inside the TTL.
    expect(await one.verify(await key({}, { kid: 'other' }), EXPECTED)).toBeNull();
    expect(await one.verify(await key(), EXPECTED)).not.toBeNull();
  });
});
