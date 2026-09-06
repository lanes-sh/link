import { describe, expect, test } from 'bun:test';
import { ControlAssertionVerifier, type ControlAssertion } from './assertion.ts';

/**
 * The gate on the control plane.
 *
 * `api.lanes.sh` decides who is calling, which workspace they named and whether
 * they may act on it; this service performs the act. Everything downstream
 * trusts what comes out of here, including which workspace's bytes get opened,
 * so a forged or misdirected assertion is not a failed request but somebody
 * else's mailbox.
 *
 * A pinned public key rather than a fetched key set, which is the difference
 * from `#auth/lanes/assertion.ts`. That one verifies a statement carried by a
 * browser to an endpoint behind somebody's firewall, so it has to be able to
 * fetch a key it has never seen. Both ends of this one are operated by Lanes and
 * configured together, so there is no key to discover, no cache to reason about,
 * and no unauthenticated path that provokes an outbound request.
 */

const ISSUER = 'https://api.example.com';
const AUDIENCE = 'https://control.example.com';

async function keypair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function mint(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' },
): Promise<string> {
  const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const signed = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}

const NOW = Date.UTC(2026, 0, 1) / 1000;

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'lanes:abc123',
    workspace: 'ws-aaa',
    role: 'admin',
    scopes: ['link:admin'],
    iat: NOW,
    exp: NOW + 60,
    jti: 'one',
    ...overrides,
  };
}

async function verifier(publicKey: CryptoKey) {
  return new ControlAssertionVerifier({
    publicKey,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW * 1000,
  });
}

describe('a control-plane assertion', () => {
  test('names the person, the workspace, the role and the scopes', async () => {
    const keys = await keypair();
    const verified = await (await verifier(keys.publicKey)).verify(await mint(keys.privateKey, claims()));

    expect(verified).toEqual({
      subject: 'lanes:abc123',
      workspace: 'ws-aaa',
      role: 'admin',
      scopes: ['link:admin'],
    } satisfies ControlAssertion);
  });

  test('refuses one signed by a different key', async () => {
    const [mine, theirs] = [await keypair(), await keypair()];
    const forged = await mint(theirs.privateKey, claims());

    expect(await (await verifier(mine.publicKey)).verify(forged)).toBeNull();
  });

  test('refuses one whose payload was edited after signing', async () => {
    const keys = await keypair();
    const token = await mint(keys.privateKey, claims({ workspace: 'ws-aaa' }));
    const [header, , signature] = token.split('.') as [string, string, string];
    const swapped = b64url(new TextEncoder().encode(JSON.stringify(claims({ workspace: 'ws-bbb' }))));

    expect(await (await verifier(keys.publicKey)).verify(`${header}.${swapped}.${signature}`)).toBeNull();
  });

  test('pins the algorithm rather than reading it from the token', async () => {
    // `alg: none` and HMAC-with-the-public-key are both attacks that work
    // exactly when a verifier honours what the token says about itself.
    const keys = await keypair();
    const token = await mint(keys.privateKey, claims(), { alg: 'none', typ: 'JWT' });

    expect(await (await verifier(keys.publicKey)).verify(token)).toBeNull();
  });

  test('refuses one minted for another environment', async () => {
    // The reason `iss` and `aud` carry the environment. Sharing a signing key
    // between stage and prod would let a stage API mint one prod accepts, and
    // this is the check that would still refuse it.
    const keys = await keypair();
    const check = await verifier(keys.publicKey);

    expect(await check.verify(await mint(keys.privateKey, claims({ iss: 'https://api-stage.example.com' })))).toBeNull();
    expect(await check.verify(await mint(keys.privateKey, claims({ aud: 'https://control-stage.example.com' })))).toBeNull();
  });

  test('refuses one that has expired, and one minted in the future', async () => {
    const keys = await keypair();
    const check = await verifier(keys.publicKey);

    expect(await check.verify(await mint(keys.privateKey, claims({ exp: NOW - 120 })))).toBeNull();
    expect(await check.verify(await mint(keys.privateKey, claims({ iat: NOW + 600, exp: NOW + 900 })))).toBeNull();
  });

  test('refuses one whose issuer granted it a long life', async () => {
    // Checked here as well as trusted from the issuer: a misconfigured API that
    // widened its own expiry would otherwise turn a per-request assertion into
    // a bearer token over every workspace, and this is the party that lives
    // with that.
    const keys = await keypair();
    const token = await mint(keys.privateKey, claims({ exp: NOW + 86_400 }));

    expect(await (await verifier(keys.publicKey)).verify(token)).toBeNull();
  });

  test('refuses one naming no workspace, or a role it does not know', async () => {
    const keys = await keypair();
    const check = await verifier(keys.publicKey);

    expect(await check.verify(await mint(keys.privateKey, claims({ workspace: '' })))).toBeNull();
    expect(await check.verify(await mint(keys.privateKey, claims({ workspace: undefined })))).toBeNull();
    expect(await check.verify(await mint(keys.privateKey, claims({ role: 'owner' })))).toBeNull();
    expect(await check.verify(await mint(keys.privateKey, claims({ sub: '' })))).toBeNull();
  });

  test('treats a missing scopes claim as no scopes rather than as every scope', async () => {
    const keys = await keypair();
    const verified = await (await verifier(keys.publicKey)).verify(
      await mint(keys.privateKey, claims({ scopes: undefined })),
    );

    expect(verified?.scopes).toEqual([]);
  });

  test('refuses a token that is not three parts', async () => {
    const keys = await keypair();
    const check = await verifier(keys.publicKey);

    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'not-a-token']) {
      expect(await check.verify(bad), bad).toBeNull();
    }
  });
});
