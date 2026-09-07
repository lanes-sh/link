import { describe, expect, test } from 'bun:test';
import { RUNTIME_SUBJECT, runtimeTokens, runtimeTokensFrom } from './identity.ts';

/**
 * The statement this runtime makes about itself, so it may read its own bytes.
 *
 * The claims are asserted verbatim because the verifier is in another language
 * in another repository (`api/src/kernel/link_runtime.py`), which is exactly
 * the situation where a rename on one side goes unnoticed until a deployment.
 * Anything checked there is pinned here.
 */

/** A key for this test only. Generated, never committed. */
async function keypair(): Promise<{ sign: CryptoKey; verify: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  return { sign: pair.privateKey, verify: pair.publicKey };
}

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key));
  const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

function claimsOf(token: string): Record<string, unknown> {
  const middle = token.split('.')[1] ?? '';
  const padded = middle.replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
}

describe('the assertion a runtime makes about itself', () => {
  test('names the workspace it is reading, and nothing wider', async () => {
    const { sign } = await keypair();
    const tokens = runtimeTokens({
      key: sign,
      issuer: 'https://runtime.example.com',
      audience: 'https://api.example.com',
      now: () => 1_700_000_000_000,
    });

    const claims = claimsOf(await tokens.token('ws-aaa'));

    // Every one of these is checked by the API. `workspace` is the load-bearing
    // one: it is why a stolen runtime token reads one tenant and not all of
    // them, which a service-account identity token could not have given us.
    expect(claims['workspace']).toBe('ws-aaa');
    expect(claims['iss']).toBe('https://runtime.example.com');
    expect(claims['aud']).toBe('https://api.example.com');
    expect(claims['sub']).toBe(RUNTIME_SUBJECT);
    expect(claims['exp']).toBe(1_700_000_060);
    expect(claims['iat']).toBe(1_700_000_000);
  });

  test('a second workspace gets a second assertion', async () => {
    const { sign } = await keypair();
    const tokens = runtimeTokens({
      key: sign,
      issuer: 'https://runtime.example.com',
      audience: 'https://api.example.com',
    });

    // The property one process serving many workspaces depends on. A token
    // minted once and reused would let whichever workspace opened first read
    // every other one's files.
    expect(claimsOf(await tokens.token('ws-aaa'))['workspace']).toBe('ws-aaa');
    expect(claimsOf(await tokens.token('ws-bbb'))['workspace']).toBe('ws-bbb');
  });

  test('lives a minute, so a captured one is worth little', async () => {
    const { sign } = await keypair();
    const tokens = runtimeTokens({
      key: sign,
      issuer: 'https://runtime.example.com',
      audience: 'https://api.example.com',
    });

    const claims = claimsOf(await tokens.token('ws-aaa'));
    // The API refuses anything claiming more than two minutes, so this failing
    // upward is a runtime that cannot read its own storage at all.
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(60);
  });

  test('verifies under the public half', async () => {
    const { sign, verify } = await keypair();
    const tokens = runtimeTokens({
      key: sign,
      issuer: 'https://runtime.example.com',
      audience: 'https://api.example.com',
    });

    const token = await tokens.token('ws-aaa');
    const [header, claims, signature] = token.split('.') as [string, string, string];
    const bytes = Uint8Array.from(
      atob(signature.replaceAll('-', '+').replaceAll('_', '/')),
      (one) => one.charCodeAt(0),
    );

    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      verify,
      bytes as unknown as ArrayBuffer,
      new TextEncoder().encode(`${header}.${claims}`) as unknown as ArrayBuffer,
    );
    expect(ok).toBe(true);
  });
});

describe('building one from the environment', () => {
  test('is absent for a local bind and a self-hosted deploy', async () => {
    // The common case, and the reason this is not simply always on: those two
    // keep their bytes on a disk or in their own bucket and never speak to the
    // API about storage at all.
    expect(await runtimeTokensFrom({ LANES_LINK_HOME: '/home/x/.lanes-link' }, 'x')).toBeUndefined();
    expect(await runtimeTokensFrom({ LANES_LINK_HOME: 'gs://my-bucket' }, 'x')).toBeUndefined();
  });

  test('refuses a lanes:// root with no key, rather than failing at the first read', async () => {
    // Without this the failure surfaces as "No credential is registered" while
    // reading `lanes-link.yaml`, which reads as a storage fault three
    // components away from the variable that is actually missing.
    await expect(
      runtimeTokensFrom({ LANES_LINK_HOME: 'lanes://ws-aaa' }, 'https://api.example.com'),
    ).rejects.toThrow(/LANES_RUNTIME_PRIVATE_KEY is not set/);
  });

  test('refuses a key with no issuer, because the issuer carries the environment', async () => {
    const { sign } = await keypair();
    await expect(
      runtimeTokensFrom(
        { LANES_LINK_HOME: 'lanes://ws-aaa', LANES_RUNTIME_PRIVATE_KEY: await pkcs8Pem(sign) },
        'https://api.example.com',
      ),
    ).rejects.toThrow(/LANES_RUNTIME_ISSUER is not/);
  });

  test('takes a PEM whose newlines were eaten', async () => {
    // A PEM is multi-line and most ways of setting an environment variable are
    // not, so it arrives with literal backslash-n roughly as often as not.
    const { sign } = await keypair();
    const escaped = (await pkcs8Pem(sign)).replaceAll('\n', '\\n');

    const tokens = await runtimeTokensFrom(
      {
        LANES_LINK_HOME: 'lanes://ws-aaa',
        LANES_RUNTIME_PRIVATE_KEY: escaped,
        LANES_RUNTIME_ISSUER: 'https://runtime.example.com',
      },
      'https://api.example.com',
    );

    expect(claimsOf(await tokens!.token('ws-aaa'))['workspace']).toBe('ws-aaa');
  });

  test('says which variable is wrong when the key will not import', async () => {
    await expect(
      runtimeTokensFrom(
        {
          LANES_LINK_HOME: 'lanes://ws-aaa',
          LANES_RUNTIME_PRIVATE_KEY: 'not a key',
          LANES_RUNTIME_ISSUER: 'https://runtime.example.com',
        },
        'https://api.example.com',
      ),
    ).rejects.toThrow(/LANES_RUNTIME_PRIVATE_KEY is not an RSA private key/);
  });
});
