import { describe, expect, test } from 'bun:test';
import { OidcVerifier, type FetchLike } from './oidc.ts';

/**
 * Verifying somebody else's token.
 *
 * A table rather than a live issuer, because what has to be right is which
 * answers are refused — and an issuer that happens to be reachable during a
 * test run proves only the happy path. Every case here is a token an issuer
 * would call perfectly valid and this endpoint must still not accept.
 */

const ISSUER = 'https://issuer.example';
const INTROSPECTION = `${ISSUER}/tokeninfo`;

/** An issuer that publishes an introspection endpoint and answers with `body`. */
function stubIssuer(body: Record<string, unknown>, options: { discovers?: boolean } = {}) {
  const calls: string[] = [];

  const stub: FetchLike = (input) => {
    const url = String(input);
    calls.push(url);

    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(
        Response.json(
          options.discovers === false ? {} : { introspection_endpoint: INTROSPECTION },
        ),
      );
    }
    return Promise.resolve(Response.json(body));
  };

  return { stub, calls };
}

function verifier(
  body: Record<string, unknown>,
  overrides: Partial<ConstructorParameters<typeof OidcVerifier>[0]> = {},
): OidcVerifier {
  const { stub } = stubIssuer(body);
  return new OidcVerifier({
    issuer: ISSUER,
    audience: 'this-application',
    allowedSubjects: ['you@example.com'],
    fetch: stub,
    now: () => 1_000_000,
    ...overrides,
  });
}

const VALID = {
  active: true,
  aud: 'this-application',
  sub: 'user-1',
  email: 'you@example.com',
  email_verified: true,
  exp: 2_000, // seconds -> 2,000,000ms, comfortably ahead of `now`
};

describe('a token that opens the endpoint', () => {
  test('is active, for this audience, unexpired, and a subject on the list', async () => {
    expect(await verifier(VALID).verify('t')).toMatchObject({ subject: 'you@example.com' });
  });

  test('may be matched on its subject id rather than an address', async () => {
    const subject = await verifier(VALID, { allowedSubjects: ['user-1'] }).verify('t');
    expect(subject).toMatchObject({ subject: 'user-1' });
  });

  test('is discovered through the issuer when config names no endpoint', async () => {
    const { stub, calls } = stubIssuer(VALID);
    const discovered = new OidcVerifier({
      issuer: ISSUER,
      audience: 'this-application',
      allowedSubjects: ['you@example.com'],
      fetch: stub,
      now: () => 1_000_000,
    });

    expect(await discovered.verify('t')).not.toBeNull();
    expect(calls[0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });
});

describe('a token that does not', () => {
  const refuses = async (body: Record<string, unknown>) =>
    expect(await verifier(body).verify('t')).toBeNull();

  test('was issued to another application the same issuer serves', async () => {
    // The confused-deputy case, and the one that works perfectly until someone
    // points a different application's token at this endpoint.
    await refuses({ ...VALID, aud: 'somebody-elses-application' });
  });

  test('names no audience at all', async () => {
    const { aud: _aud, ...withoutAudience } = VALID;
    await refuses(withoutAudience);
  });

  test('has expired', async () => {
    await refuses({ ...VALID, exp: 999 });
  });

  test('belongs to an account that is not on the list', async () => {
    // The issuer will vouch for every account it has. Which of them is *you*
    // is not something it knows.
    await refuses({ ...VALID, sub: 'someone-else', email: 'someone@example.com' });
  });

  test('carries an email the issuer has not verified', async () => {
    // An unverified address is a string the account holder typed, so matching
    // an allowlist against one would let anyone claim to be the owner.
    await refuses({ ...VALID, sub: 'someone-else', email_verified: false });
  });

  test('the issuer reports as inactive', async () => {
    await refuses({ ...VALID, active: false });
  });
});

describe('when the issuer cannot answer', () => {
  test('a missing introspection endpoint fails closed and says what to set', async () => {
    // Falling back to a check that cannot see the audience would leave the
    // confused-deputy hole open while looking like it verified something.
    const { stub } = stubIssuer(VALID, { discovers: false });
    const blind = new OidcVerifier({
      issuer: ISSUER,
      audience: 'this-application',
      allowedSubjects: ['you@example.com'],
      fetch: stub,
    });

    await expect(blind.verify('t')).rejects.toThrow(/introspection_endpoint/);
  });

  test('an unreachable issuer is not an authorisation', async () => {
    const failing = new OidcVerifier({
      issuer: ISSUER,
      audience: 'this-application',
      allowedSubjects: ['you@example.com'],
      introspectionEndpoint: INTROSPECTION,
      fetch: () => Promise.reject(new Error('network down')),
    });

    expect(await failing.verify('t')).toBeNull();
  });
});

describe('caching', () => {
  test('a verified token is not re-asked about on every call', async () => {
    // Otherwise every MCP request pays a round trip to the identity provider.
    const { stub, calls } = stubIssuer(VALID);
    const cached = new OidcVerifier({
      issuer: ISSUER,
      audience: 'this-application',
      allowedSubjects: ['you@example.com'],
      introspectionEndpoint: INTROSPECTION,
      fetch: stub,
      now: () => 1_000_000,
    });

    await cached.verify('t');
    const afterFirst = calls.length;
    await cached.verify('t');

    expect(calls.length).toBe(afterFirst);
  });

  test('a refusal is never cached', async () => {
    // A token refused because the issuer was briefly unreachable must get
    // another chance; caching the "no" would extend one blip into a minute.
    const { stub, calls } = stubIssuer({ ...VALID, aud: 'wrong' });
    const cached = new OidcVerifier({
      issuer: ISSUER,
      audience: 'this-application',
      allowedSubjects: ['you@example.com'],
      introspectionEndpoint: INTROSPECTION,
      fetch: stub,
      now: () => 1_000_000,
    });

    await cached.verify('t');
    const afterFirst = calls.length;
    await cached.verify('t');

    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  test('a cache entry never outlives the token it describes', async () => {
    const soon = { ...VALID, exp: 1_030 };
    const { stub } = stubIssuer(soon);
    const cached = new OidcVerifier({
      issuer: ISSUER,
      audience: 'this-application',
      allowedSubjects: ['you@example.com'],
      introspectionEndpoint: INTROSPECTION,
      fetch: stub,
      now: () => 1_000_000,
      cacheTtlMs: 600_000,
    });

    // The TTL says ten minutes; the token has thirty seconds left.
    expect(await cached.verify('t')).toMatchObject({ expiresAt: 1_030_000 });
  });
});
