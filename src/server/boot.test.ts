import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAdd } from '#cli/commands/profile.ts';
import { tokenIssue, tokenShow } from '#cli/commands/operate/token.ts';
import { version } from '#cli/version.ts';
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

/** Run a command that reports on stdout, and hand back what it wrote. */
async function capture(run: () => Promise<void>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    };
    await run();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = write;
  }
  return out;
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


  test('and tells a client which release it is', async () => {
    // `serverInfo.version` is the only place a client or an operator can see
    // what a running instance actually is, and it answered `0.0.0` on every
    // endpoint this project has ever served. The value was read here and handed
    // to the read surface alone, so `buildMcpServer` fell through to its
    // fallback — over HTTP and over stdio alike.
    //
    // Asserted through `startEndpoint` rather than the harness, deliberately.
    // The harness wires `serveOverStdio` and `buildMcpServer` itself, so it
    // would have passed throughout: what broke is the wiring, and only a real
    // boot exercises it.
    const home = await workspace();
    const previous = process.env['LANES_LINK_HOME'];
    process.env['LANES_LINK_HOME'] = home;

    const port = allocatePort();
    let endpoint: Awaited<ReturnType<typeof startEndpoint>> | null = null;

    try {
      const issue = { target: 'local', quiet: true, subject: 'lanes:boottest01' };
      await capture(() => tokenIssue(issue));
      const token = (await capture(() => tokenShow({ ...issue, raw: true }))).trim();

      const flags = { target: 'local', quiet: true, profile: await primaryProfile({ target: 'local' }) };
      endpoint = await startEndpoint({ flags, port, host: '127.0.0.1' });

      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'boot-test', version: '1' },
          },
        }),
      });

      const raw = await response.text();
      const line = raw
        .split('\n')
        .map((part) => (part.startsWith('data:') ? part.slice(5).trim() : part.trim()))
        .find((part) => part.startsWith('{'));
      const info = (JSON.parse(line ?? '{}').result ?? {}).serverInfo as
        | { name?: string; version?: string }
        | undefined;

      expect(info?.name).toBe('lanes-link');
      expect(info?.version).toBe(version());
      // Named, because it is what the whole test is about.
      expect(info?.version).not.toBe('0.0.0');
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
