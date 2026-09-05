import { describe, expect, test } from 'bun:test';
import { controlDepsFrom } from './boot.ts';

/**
 * Turning the control surface on, which nothing did.
 *
 * `ServerOptions.control` existed, `serve()` dispatched on it, and
 * `ControlAssertionVerifier` was written and tested — and no code path anywhere
 * constructed either. Every control test called `controlRoutes` directly with a
 * stub, so the whole surface was green and unreachable at the same time. This
 * is the missing composition root, and these tests are mostly about the refusals
 * that stop it being turned half-on.
 */

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo
4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u
+qKhbwKfBstIs+bMY2Zkp18gnTxKLxoS2tFczGkPLPgizskuemMghRniWaoLcyeh
kd3qqGElvW/VDL5AaWTg0nLVkjRo9z+40RQzuVaE8AkAFmxZzow3x+VJYKdjykkJ
0iT9wCS0DRTXu269V264Vf/3jvredZiKRkgwlL9xNAwxXFg0x/XFw005UWVRIkdg
cKWTjpBP2dPwVZ4WWC+9aGVd+Gyn1o0CLelf4rEjGoXbAAEgAqeGUxrcIlbjXfbc
mwIDAQAB
-----END PUBLIC KEY-----`;

const ENV = {
  LANES_LINK_HOME: 'lanes://ws-abc',
  LANES_CONTROL_PUBLIC_KEY: PUBLIC_KEY,
  LANES_CONTROL_ISSUER: 'https://api.example.com',
  LANES_CONTROL_AUDIENCE: 'https://runtime.example.com',
};

describe('when the environment says nothing about control', () => {
  test('there is no control surface', async () => {
    // The self-hosted and local case, and the one that must stay true: absent
    // deps is what keeps ADR-007 literally true for those endpoints.
    expect(await controlDepsFrom({ LANES_LINK_HOME: '/home/someone/.lanes-link' })).toBeUndefined();
  });

  test('not even on a managed-looking root', async () => {
    // A `lanes://` root alone does not turn it on. The key does.
    expect(await controlDepsFrom({ LANES_LINK_HOME: 'lanes://ws-abc' })).toBeUndefined();
  });
});

describe('when it is configured', () => {
  test('the deps name the workspace the root does', async () => {
    const deps = await controlDepsFrom(ENV);
    expect(deps?.workspace).toBe('ws-abc');
  });

  test('and carry a verifier', async () => {
    const deps = await controlDepsFrom(ENV);
    expect(typeof deps?.verifier.verify).toBe('function');
  });

  test('a garbled key is refused at boot, not at the first request', async () => {
    // The alternative is a revision that goes healthy and then refuses every
    // control call with the same "no" a forged assertion gets — indistinguishable
    // in a log from an attack.
    await expect(
      controlDepsFrom({ ...ENV, LANES_CONTROL_PUBLIC_KEY: 'not a key' }),
    ).rejects.toThrow(/public key/i);
  });
});

describe('what it refuses to start half-configured', () => {
  test('a key without an issuer', async () => {
    const { LANES_CONTROL_ISSUER: _, ...rest } = ENV;
    await expect(controlDepsFrom(rest)).rejects.toThrow(/LANES_CONTROL_ISSUER/);
  });

  test('a key without an audience', async () => {
    // The audience is this service's own URL and carries the environment
    // (ADR-072). Defaulting it would let a stage runtime accept a prod-signed
    // assertion, which is the exact thing that separation exists to stop.
    const { LANES_CONTROL_AUDIENCE: _, ...rest } = ENV;
    await expect(controlDepsFrom(rest)).rejects.toThrow(/LANES_CONTROL_AUDIENCE/);
  });

  test('a key on a workspace root that names no workspace', async () => {
    await expect(
      controlDepsFrom({ ...ENV, LANES_LINK_HOME: '/home/someone/.lanes-link' }),
    ).rejects.toThrow(/lanes:\/\//);
  });
});

describe('what ships to a CLI user', () => {
  test('the container entrypoint does not statically import control code', async () => {
    /**
     * `lanes link deploy` submits the *installed package* as its build source
     * (`installRoot`, in `deployments/gcp/driver.ts`), and package.json's
     * `files` excludes `src/control/**` — it is Lanes-only code with no
     * business in every CLI user's node_modules.
     *
     * So a static `import … from '#control/…'` in `container.ts` resolves here
     * and fails at startup in every self-hosted container. It has to be a
     * dynamic import behind the switch, and this is the only thing that would
     * notice if somebody tidied it back into the header.
     */
    const source = await Bun.file(
      new URL('../server/container.ts', import.meta.url).pathname,
    ).text();

    const staticImports = source
      .split('\n')
      .filter((line) => /^import\s/.test(line) && line.includes('#control/'));

    expect(staticImports).toEqual([]);
    // And it really is reached, rather than having been dropped entirely.
    expect(source).toContain("await import('#control/boot.ts')");
  });

  test('package.json still excludes control from the published files', async () => {
    // The other half of the pair above. If this exclusion ever went away the
    // dynamic import would become unnecessary — but silently, and the next
    // person would find the comment explaining a constraint that had lapsed.
    const manifest = await Bun.file(
      new URL('../../package.json', import.meta.url).pathname,
    ).json();

    expect(manifest.files).toContain('!src/control/**');
  });
});
