import { json } from './http.ts';
import type { ReadDeps } from './routes.ts';

/**
 * The two steps that turn the workspace's pairing token into a person.
 *
 * `challenge` mints a nonce; `session` spends it against an assertion lanes.sh
 * signed for this endpoint, and answers with a session naming the subject.
 * These are the only paths the bare pairing token opens, and the session is the
 * only credential every other path accepts (ADR-079).
 *
 * The paths live here rather than in `./routes.ts` so that the import runs one
 * way. That file needs these two constants at runtime; this one needs only
 * `ReadDeps`, which is a type and erases.
 */
export const CHALLENGE_PATH = '/pair/challenge';
export const SESSION_PATH = '/pair/session';

/** The exchange itself, which takes the pairing token rather than a session. */
export function isPairingPath(pathname: string): boolean {
  return pathname === CHALLENGE_PATH || pathname === SESSION_PATH;
}

/**
 * The exchange: a workspace's pairing token, plus proof of who is holding it.
 *
 * Two steps rather than one, because an assertion is minted for a nonce this
 * endpoint chose. `GET /pair/challenge` hands out the nonce; the page takes it
 * to lanes.sh, which signs a statement naming the signed-in person for this
 * audience; `POST /pair/session` spends the nonce against that statement and
 * answers with a session.
 *
 * What each field stops is worth being explicit about, because the same three
 * carry the endpoint's own consent flow (ADR-062) and both would be decorative
 * if any were dropped. The **audience** is this read surface's own base URL, so
 * a statement minted here cannot be replayed into an authorization at `/mcp`
 * and one minted for another endpoint cannot be presented here. The **nonce**
 * is spent on first use, so a statement cannot open two sessions. The
 * **lifetime** is the API's sixty seconds, which crosses one redirect.
 *
 * A workspace that has bound no Lanes workspace still resolves subjects
 * through its own `members:` — the lists name Lanes subjects either way, and
 * `profile add` writes the signed-in one. What an unbound workspace lacks is a
 * roster to *validate a new name against*, which is `profile members add`'s
 * problem and not this one.
 */
export async function pairingRoutes(
  request: Request,
  url: URL,
  deps: ReadDeps,
  headers: Record<string, string>,
): Promise<Response> {
  const { sessions, federation } = deps;
  const resource = deps.resource ?? url.origin;

  // An endpoint that cannot verify an assertion cannot tell one caller from
  // another, and the honest answer is that pairing is unavailable rather than a
  // session naming nobody. The dashboard reads this and says which version
  // introduced the exchange.
  if (!sessions || !federation) {
    return json({ error: 'pairing_unavailable' }, 404, headers);
  }

  if (url.pathname === CHALLENGE_PATH && request.method === 'GET') {
    return json(
      { nonce: await sessions.challenge(), resource, consent: federation.consentUrl },
      200,
      headers,
    );
  }

  if (url.pathname !== SESSION_PATH || request.method !== 'POST') {
    return json({ error: 'not_found' }, 404, headers);
  }

  const body = (await request.json().catch(() => null)) as { assertion?: unknown } | null;
  const assertion = typeof body?.assertion === 'string' ? body.assertion : null;
  const nonce = url.searchParams.get('nonce');

  if (assertion === null || nonce === null) {
    return json({ error: 'assertion_required' }, 400, headers);
  }

  // Spent before it is used, and spent whether or not what follows succeeds. A
  // nonce consumed only on the happy path is one a failed attempt leaves live.
  if (!(await sessions.spend(nonce))) {
    return json({ error: 'assertion_required' }, 400, headers);
  }

  const person = await federation
    .verify(assertion, { audience: resource, nonce })
    .catch(() => null);

  if (person === null) {
    // One reason for every way a statement can fail to verify. "The audience
    // was wrong" tells an attacker which attempt got closer and tells a
    // legitimate caller nothing they can act on — the rule `AssertionVerifier`
    // already follows, kept here rather than restated.
    return json({ error: 'assertion_invalid' }, 401, headers);
  }

  // The same expression `server/endpoint.ts` hands `openAuthorization`, over
  // the same live map. A profile is reachable because it names this subject,
  // and for no other reason.
  const profiles = [...deps.profiles()]
    .filter(([, runtime]) =>
      runtime.config.members.some((member) => member.subject === person.subject),
    )
    .map(([name]) => name);

  const opened = await sessions.open({ subject: person.subject, profiles });

  // A session naming somebody no profile lists is a real outcome and not an
  // error: they signed in, and nothing here is theirs. It is answered rather
  // than refused so the dashboard can say *that*, which is a sentence naming
  // the command that fixes it, instead of "sign in again" — advice that cannot
  // work for a person whose sign-in was never the problem.
  return json(
    {
      token: opened.token,
      expires_at: new Date(opened.expiresAt).toISOString(),
      subject: person.subject,
      email: person.email,
      profiles,
    },
    200,
    headers,
  );
}
