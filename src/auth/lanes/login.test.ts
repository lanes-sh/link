import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login } from './login.ts';

/**
 * Signing in, without a browser or a network.
 *
 * Everything outside this process is injected — the fetch, the "open a browser"
 * step, and *where the session is written* — so the flow is exercised as a
 * sequence of values. The last of those is not fastidiousness: without it these
 * tests sign the developer's own machine in as a fixture, which is how it was
 * discovered.
 *
 * What is pinned is the part that is easy to get wrong and impossible to notice:
 * PKCE is sent, `state` is checked, the *same* redirect URI goes to the
 * exchange, and the token that gets stored is the Lanes one rather than
 * Google's.
 */

const homes: string[] = [];

/** A throwaway `$HOME`, so no test writes a session into the real one. */
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-login-'));
  homes.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(homes.map((one) => rm(one, { recursive: true, force: true })));
});

const CONFIG = {
  data: {
    client_id: 'a-client-id.apps.googleusercontent.com',
    firebase_api_key: 'a-web-api-key',
    firebase_project_id: 'a-project',
  },
};

interface Recorded {
  authorizeUrl: URL;
  exchange: Record<string, unknown>;
  signIn: Record<string, unknown>;
}

/**
 * What the code actually needs, rather than `typeof fetch`.
 *
 * Bun's `fetch` carries a `preconnect` property, so a plain function is not
 * assignable to it — and a test double growing a method it never calls, to
 * satisfy a type, is a double that has stopped standing for anything.
 */
type Call = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A fetch that plays every leg, and a browser that answers the callback.
 *
 * `open` is where the pretend user lives: it receives the authorize URL, reads
 * the redirect and the state out of it, and calls back exactly as Google would.
 */
function harness(
  overrides: { state?: string; idToken?: string } = {},
): { fetch: Call; open: (url: string) => Promise<void>; recorded: Partial<Recorded> } {
  const recorded: Partial<Recorded> = {};

  const call: Call = async (input, init) => {
    const url = String(input);

    if (url.endsWith('/v1/auth/google/config')) {
      return Response.json(CONFIG);
    }

    if (url.endsWith('/v1/auth/google/exchange')) {
      recorded.exchange = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: { id_token: overrides.idToken ?? 'google-id-token' } });
    }

    if (url.includes('accounts:signInWithIdp')) {
      recorded.signIn = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        localId: 'FIREBASEUID000000000000000000',
        email: 'someone@example.com',
        idToken: 'lanes-id-token',
        refreshToken: 'lanes-refresh-token',
        expiresIn: '3600',
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };

  const open = async (raw: string): Promise<void> => {
    const url = new URL(raw);
    recorded.authorizeUrl = url;

    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', 'an-authorization-code');
    redirect.searchParams.set('state', overrides.state ?? url.searchParams.get('state')!);

    // Fired without awaiting: the listener is only serving once `login` is
    // waiting on it, and awaiting here would deadlock the two.
    void fetch(redirect).catch(() => {});
  };

  return { fetch: call, open, recorded };
}

describe('the browser leg', () => {
  test('asks for a code with PKCE, offline access, and a fresh consent screen', async () => {
    const { fetch: call, open, recorded } = harness();
    await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    const url = recorded.authorizeUrl!;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    // Both, or Google returns no refresh token on a second sign-in and the
    // session quietly lasts an hour instead of indefinitely.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  test('redirects to loopback on a port the kernel picked', async () => {
    const { fetch: call, open, recorded } = harness();
    await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    const redirect = new URL(recorded.authorizeUrl!.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
  });

  test('refuses a callback whose state does not match', async () => {
    // The only thing standing between this listener and a page on the machine
    // feeding it somebody else's authorization code.
    const { fetch: call, open } = harness({ state: 'not-the-state-we-sent' });

    await expect(
      login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() }),
    ).rejects.toThrow(/wrong state/);
  });
});

describe('the exchange', () => {
  test('sends the verifier and the same redirect the browser was given', async () => {
    // Google checks the redirect matches, and a mismatch is a failure with a
    // message about the client rather than about the URI — so this is pinned
    // rather than left to be rediscovered.
    const { fetch: call, open, recorded } = harness();
    await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    const sent = recorded.exchange!;
    expect(sent['code']).toBe('an-authorization-code');
    expect(sent['code_verifier']).toBeTruthy();
    expect(sent['redirect_uri']).toBe(
      recorded.authorizeUrl!.searchParams.get('redirect_uri'),
    );
  });

  test("hands Google's id token to Firebase, and stores the Lanes one", async () => {
    // The distinction the whole file exists for: Google's token says who signed
    // in to Google, and no part of Lanes accepts it. The subject a profile's
    // members list names comes from the Firebase exchange.
    const { fetch: call, open, recorded } = harness();
    const session = await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    expect(String(recorded.signIn!['postBody'])).toContain('id_token=google-id-token');
    expect(session.idToken).toBe('lanes-id-token');
    expect(session.refreshToken).toBe('lanes-refresh-token');
  });

  test('prefixes the subject, so it can be written into a profile at all', async () => {
    // `secret-detection.ts` refuses a bare Firebase uid as a high-entropy blob,
    // and `subjectRef` requires the prefix. A session storing the raw id would
    // produce a subject that `members:` cannot hold — see `profile/primitives.ts`.
    const { fetch: call, open } = harness();
    const session = await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    expect(session.subject).toBe('lanes:FIREBASEUID000000000000000000');
  });

  test('records which API issued it', async () => {
    // A session is not portable between deployments: the subject means
    // something only to the identity provider that minted it.
    const { fetch: call, open } = harness();
    const session = await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    expect(session.apiUrl).toBe('https://api.example.com');
  });
});

describe('an API that cannot sign anybody in', () => {
  test('says which setting is missing rather than failing at Google', async () => {
    const call: Call = async () => Response.json({ data: { client_id: '' } });

    await expect(login({ apiUrl: 'https://api.example.com', fetch: call })).rejects.toThrow(
      /GOOGLE_OAUTH_CLIENT_ID or FIREBASE_API_KEY/,
    );
  });

  test('names the override when the API is unreachable', async () => {
    const call: Call = async () => new Response('nope', { status: 503 });

    await expect(login({ apiUrl: 'https://api.example.com', fetch: call })).rejects.toThrow(
      /LANES_API_URL/,
    );
  });
});

describe('the page the browser is left on', () => {
  test('actually arrives, on a sign-in that worked', async () => {
    // The regression this file exists to hold from here on. `awaitCallback` used
    // to tear the listener down with `stop(true)`, which force-closes active
    // connections — and the active connection is the one carrying this page.
    // `resolve` runs inside the handler, before Bun has written the response, so
    // the teardown raced the browser and won every time.
    //
    // What that looked like was a connection error on a sign-in that had already
    // succeeded: the code was captured, the exchange happened, the session was
    // written, and the person was looking at "This site can't be reached".
    //
    // Every other test here fires the callback with `void fetch(...).catch()`,
    // which is what let this through. This one waits for the answer.
    const { fetch: call, recorded } = harness();

    let delivered: Response | null = null;
    const open = async (raw: string): Promise<void> => {
      const url = new URL(raw);
      recorded.authorizeUrl = url;

      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'an-authorization-code');
      back.searchParams.set('state', url.searchParams.get('state')!);

      // Not awaited: `login` is not listening for the answer yet. Captured so
      // the assertion below can wait for it.
      void fetch(back).then((response) => void (delivered = response));
    };

    await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });

    // The listener is stopped by now, so this is asking whether the response
    // escaped before it went.
    await Bun.sleep(50);

    expect(delivered).not.toBeNull();
    expect(delivered!.status).toBe(200);
    expect(await delivered!.text()).toContain('Signed in');
  });

  test('closes its connection, so the graceful stop cannot hang on keep-alive', async () => {
    // What makes "respond, then stop" a sequence rather than a race. Without it
    // the choice is a forced close, which is the bug above, or a stop that waits
    // on a socket the browser is holding open.
    const { fetch: call, recorded } = harness();

    let delivered: Response | null = null;
    const open = async (raw: string): Promise<void> => {
      const url = new URL(raw);
      recorded.authorizeUrl = url;
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'an-authorization-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      void fetch(back).then((response) => void (delivered = response));
    };

    await login({ apiUrl: 'https://api.example.com', fetch: call, open, home: await home() });
    await Bun.sleep(50);

    expect(delivered!.headers.get('connection')).toBe('close');
  });
});
