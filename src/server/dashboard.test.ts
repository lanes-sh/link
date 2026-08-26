import { afterAll, describe, expect, test } from 'bun:test';
import { allocatePort, startHarness, TEST_TOKEN } from './harness.ts';
import { dashboardSessions, servesDashboard } from './dashboard.ts';

/**
 * The dashboard, against a real server on a real port.
 *
 * Two properties carry the security of this route and neither is visible from
 * the rendering code: it is absent unless the entrypoint asked for it and the
 * bind is loopback, and it is refused unless a browser has exchanged the
 * profile token for a session. Everything else on the page is a string.
 */

/** Serving it, as `lanes link start` does. */
const on = startHarness({
  profile: 'personal',
  port: allocatePort(),
  dashboard: true,
  policy: `  allow:
    - "example.*"`,
});

/** Not serving it, as the container entrypoint does not. */
const off = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"`,
});

afterAll(async () => {
  await Promise.all([on.stop(), off.stop()]);
});

const origin = (harness: typeof on): string => new URL(harness.server.url).origin;

/** A browser's first request: the key in the URL, exchanged for a cookie. */
async function signIn(token = TEST_TOKEN): Promise<{ status: number; cookie: string | null }> {
  const response = await fetch(`${origin(on)}/dashboard?k=${token}`, { redirect: 'manual' });
  return { status: response.status, cookie: response.headers.get('set-cookie') };
}

async function page(query = ''): Promise<{ status: number; body: string }> {
  const { cookie } = await signIn();
  const response = await fetch(`${origin(on)}/dashboard${query}`, {
    headers: { cookie: cookie!.split(';')[0]! },
  });
  return { status: response.status, body: await response.text() };
}

describe('whether it is served at all', () => {
  test('a handler that was not asked for it 404s, like any unknown path', async () => {
    // The container entrypoint never passes the flag. This is the assertion
    // that a deployed instance has no dashboard — the deploy itself cannot be
    // reached from a test, but the one decision it turns on can.
    const response = await fetch(`${origin(off)}/dashboard`);
    expect(response.status).toBe(404);
  });

  test('a routable bind never serves it, whatever the entrypoint asked for', () => {
    // The second, independent reason. A bind that is not loopback is a deployed
    // one, and ADR-018 leaves a browser no way through either door in front of
    // it — so the page would be unreachable or unguarded, never correct.
    expect(servesDashboard(true, true)).toBe(true);
    expect(servesDashboard(true, false)).toBe(false);
    expect(servesDashboard(undefined, true)).toBe(false);
    expect(servesDashboard(false, true)).toBe(false);
  });
});

describe('signing a browser in', () => {
  test('no cookie and no key is refused, and says what to run', async () => {
    const response = await fetch(`${origin(on)}/dashboard`);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain('lanes link dashboard');
  });

  test('the key is exchanged for a session and redirected out of the URL', async () => {
    const { status, cookie } = await signIn();

    expect(status).toBe(303);
    expect(cookie).toContain('lanes_link_dashboard=');
    // A token in the address bar is a token in the history and in the next
    // Referer. It is only ever needed for this one request.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain(TEST_TOKEN);
  });

  test('the redirect drops the key and keeps everything else', async () => {
    const response = await fetch(`${origin(on)}/dashboard?k=${TEST_TOKEN}&profile=personal`, {
      redirect: 'manual',
    });

    expect(response.headers.get('location')).toBe('/dashboard?profile=personal');
  });

  test('a wrong key gets a session for nothing', async () => {
    const { status, cookie } = await signIn('llk_not_the_token');

    expect(status).toBe(401);
    expect(cookie).toBeNull();
  });

  test('a cookie this endpoint did not issue is not a session', async () => {
    const response = await fetch(`${origin(on)}/dashboard`, {
      headers: { cookie: 'lanes_link_dashboard=00000000-0000-4000-8000-000000000000' },
    });

    expect(response.status).toBe(401);
  });

  test('a session expires rather than lasting as long as the process', async () => {
    let now = 0;
    const sessions = dashboardSessions(() => now);
    const id = sessions.issue();

    expect(sessions.valid(id)).toBe(true);
    now = 13 * 60 * 60 * 1000;
    expect(sessions.valid(id)).toBe(false);
  });

  test('only a read is served', async () => {
    const response = await fetch(`${origin(on)}/dashboard`, { method: 'POST' });
    expect(response.status).toBe(405);
  });
});

describe('what the page says', () => {
  test('every declared connection, with the account behind it', async () => {
    const { status, body } = await page();

    expect(status).toBe(200);
    expect(body).toContain('example.a');
    expect(body).toContain('Scratch A');
    expect(body).toContain('example.b');
  });

  test('a connection the store has not reconciled is not reported as working', async () => {
    // Config says what should exist and the store says what does. Showing the
    // first as though it were the second is the whole failure this join avoids.
    const { body } = await page();
    expect(body).toContain('not reconciled');
  });

  test('a reconciled connection carries the state the store gave it', async () => {
    await on.state.connections.upsert({
      provider: 'example',
      id: 'a',
      displayName: 'Scratch A',
      status: 'active',
    });

    const { body } = await page();
    expect(body).toContain('active');
  });

  test('every command names both the profile and the target', async () => {
    // The shell a line is pasted into resolves both for itself. A page showing
    // one profile while handing over a command that acts on another is worse
    // than a page showing nothing.
    const { body } = await page();
    const commands = [...body.matchAll(/data-copy="(lanes link [^"]+)"/g)].map((m) => m[1]!);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('--profile personal');
      expect(command).toContain('--target local');
    }
  });

  test('a provider with no connection is offered, with the line that connects it', async () => {
    // Named by shape rather than by vendor: the catalogue is a list that grows,
    // and a test pinned to one entry of it fails on the day another is added.
    const { body } = await page();
    const offered = [...body.matchAll(/data-copy="lanes link connect ([a-z_]+)[^"]*"/g)].map(
      (match) => match[1]!,
    );

    // The configured-but-unreconciled connection contributes its repair line...
    expect(offered).toContain('example');
    // ...and the catalogue contributes everything nothing is connected to.
    expect(offered.filter((id) => id !== 'example').length).toBeGreaterThan(0);
  });

  test('the owner layer is not offered as something to connect', async () => {
    // `memory`, `skills`, `vault` and `setup` are registered separately and are
    // not in the catalogue — there is no account behind them to authorise, so a
    // card inviting you to connect one would be an invitation to nothing.
    const { body } = await page();
    expect(body).not.toContain('lanes link connect setup');
    expect(body).not.toContain('lanes link connect vault');
  });

  test('the profile and target it is reporting on are on the page', async () => {
    const { body } = await page();
    expect(body).toContain('personal');
    expect(body).toContain('local');
  });

  test('refuses a profile this endpoint does not serve, rather than picking one', async () => {
    // Every profile link on the page comes from the served list, so a name that
    // is not on it was typed. Rendering a different profile than the URL names
    // is the silent pick `resolveSelection` exists to prevent.
    const { status } = await page('?profile=nonexistent');
    expect(status).toBe(404);
  });

  test('is not embeddable, and is not cached', async () => {
    const { cookie } = await signIn();
    const response = await fetch(`${origin(on)}/dashboard`, {
      headers: { cookie: cookie!.split(';')[0]! },
    });

    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
