import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAdd } from '#cli/commands/profile.ts';
import { primaryProfile } from '#cli/runtime.ts';
import { startEndpoint } from './endpoint.ts';
import { allocatePort } from './harness.ts';

/**
 * The endpoint boots with no static token issued.
 *
 * This is a test for a deletion, which is why it exists at all. `startEndpoint`
 * used to do one of two things at this point: mint a token when `start` asked
 * it to, or **refuse to boot** when a deployed revision found none — on the
 * reasoning that an endpoint whose token nobody holds is no use.
 *
 * Since ADR-062 that is backwards, and ADR-068 removed both halves. A client
 * discovers the protected-resource document from the 401 and signs its owner
 * in; a static row is what CI uses because it has no browser. So **zero rows is
 * the ordinary state of a healthy endpoint**, and the deployed case — where
 * nothing mints anything — is the one that used to throw.
 *
 * Asserted against a real workspace and a real socket rather than the harness,
 * because the harness wires an authenticator directly and would demonstrate
 * that the harness works.
 */

const homes: string[] = [];

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'lanes-boot-'));
  homes.push(home);
  const previous = process.env['LANES_LINK_HOME'];
  process.env['LANES_LINK_HOME'] = home;
  // Swallowed, not because the output is uninteresting but because `profileAdd`
  // writes its JSON to the same stdout the test reporter uses.
  const write = process.stdout.write.bind(process.stdout);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (): boolean => true;
    await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = write;
    if (previous === undefined) delete process.env['LANES_LINK_HOME'];
    else process.env['LANES_LINK_HOME'] = previous;
  }
  return home;
}

describe('a workspace that has issued no token', () => {
  test('boots, serves, and says how to authorise', async () => {
    const home = await workspace();
    const previous = process.env['LANES_LINK_HOME'];
    process.env['LANES_LINK_HOME'] = home;

    const port = allocatePort();
    let endpoint: Awaited<ReturnType<typeof startEndpoint>> | null = null;

    try {
      // No `mintToken`, because there is no such option any more, and nothing
      // here has written a credential.
      // The primary, resolved the way `serve.ts` resolves it: `startEndpoint`
      // opens a runtime and a runtime names a profile. What `--profile` no
      // longer decides is whose token opens it (ADR-068).
      const flags = { target: 'local', quiet: true, profile: await primaryProfile({ target: 'local' }) };
      endpoint = await startEndpoint({ flags, port, host: '127.0.0.1' });

      expect(endpoint.profiles).toEqual(['personal']);

      // Up, and withholding the profile list from an anonymous caller.
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toEqual({ status: 'ok' });

      // And the 401 carries where to go next, which is the whole of ADR-062's
      // flow: without this a client with no credential has nothing to do.
      const refused = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toContain(
        'oauth-protected-resource',
      );
    } finally {
      await endpoint?.stop();
      if (previous === undefined) delete process.env['LANES_LINK_HOME'];
      else process.env['LANES_LINK_HOME'] = previous;
    }
  });

  test('and refuses a token that was never issued, distinctly from a wrong one', async () => {
    const home = await workspace();
    const previous = process.env['LANES_LINK_HOME'];
    process.env['LANES_LINK_HOME'] = home;

    const port = allocatePort();
    let endpoint: Awaited<ReturnType<typeof startEndpoint>> | null = null;

    try {
      const flags = { target: 'local', quiet: true, profile: await primaryProfile({ target: 'local' }) };
      endpoint = await startEndpoint({ flags, port, host: '127.0.0.1' });

      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer llk_invented' },
        body: '{}',
      });

      // Refused, and not by crashing: the endpoint is serving, it simply holds
      // no row this could match.
      expect(response.status).toBe(401);
    } finally {
      await endpoint?.stop();
      if (previous === undefined) delete process.env['LANES_LINK_HOME'];
      else process.env['LANES_LINK_HOME'] = previous;
    }
  });
});
