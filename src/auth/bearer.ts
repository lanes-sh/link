/**
 * The credential the workspace keeps a copy of.
 *
 * Beside `remote.ts` rather than inside `index.ts`, and the split is the one
 * the file was already asking for: `index.ts` is the shape every surface shares
 * — an outcome, a chain, how a bearer is parsed and compared — while each way
 * of *proving* a credential is its own subject. Three of them were already in
 * `remote.ts`; this is the fourth, and the only one whose answer is a
 * comparison against something stored rather than a verification.
 *
 * It imports its shared pieces back from `index.ts` exactly as `remote.ts`
 * does, so `#auth` stays the one name every other component uses.
 */

import type { SecretRef, SecretStore } from '#secrets';

import {
  machinePrincipal,
  parseBearer,
  tokensMatch,
  type AuthOutcome,
  type Authenticator,
} from './index.ts';

/**
 * One issued token, as the authenticator needs it.
 *
 * Structurally what `connections.yaml` holds, declared here rather than
 * imported: `auth` may not reach `#profile` (the architecture test enforces the
 * direction), and the rows arrive as a closure for the same reason
 * `profilesFor` does.
 */
export interface IssuedToken {
  readonly id: string;
  readonly subject: string;
  readonly ref: SecretRef;
}

export interface AuthenticatorOptions {
  /**
   * The primary, which is what `principal.profile` starts as.
   *
   * Not what the token reaches — that is `profilesFor(subject)`. It is where
   * the connection was opened, and every dispatch rewrites it with `forProfile`.
   */
  readonly profile: string;
  /** The workspace's issued tokens. Re-read on every reload, so a revoke lands. */
  readonly tokens: () => Promise<readonly IssuedToken[]>;
  readonly credentials: SecretStore;
  /**
   * Which profiles list this subject as a member.
   *
   * The same resolver the OAuth path is handed (`server/endpoint.ts`), passed in
   * rather than reached for, so discovery and enforcement cannot disagree about
   * a subject's reach.
   */
  readonly profilesFor: (subject: string) => Promise<readonly string[]>;
  /**
   * Where a row that could not be read is reported.
   *
   * A closure rather than a logger, for the same reason `tokens` and
   * `profilesFor` are closures: `auth` may not reach the components that own
   * one. `cli/runtime/open.ts` supplies it.
   *
   * Optional because most callers are tests, and because the skip is already
   * correct without it — but a caller serving requests should pass one. A
   * credential the operator issued and this endpoint cannot read is invisible
   * otherwise, which is the failure `server/container.ts` was rewritten about.
   */
  readonly report?: (message: string) => void;
  /** Injectable for tests. Only the cache window reads it. */
  readonly now?: () => number;
}

/**
 * How long a cached token may answer before the store is consulted again.
 *
 * The cache is here so the common case — a valid token, on every request — is a
 * comparison rather than a file read or a Secret Manager call. What it must not
 * do is outlive a rotation. `lanes link token rotate` is the only revocation
 * this system has, and an unbounded cache meant a revoked token kept opening the
 * endpoint until the process restarted, while the replacement was refused.
 *
 * Five seconds makes rotation effectively immediate and still collapses a burst
 * of calls onto one read.
 */
const CACHE_TTL_MS = 5_000;

/** An issued row, with its value read out of the store. */
interface LoadedToken {
  readonly subject: string;
  readonly value: string;
}

/**
 * An issued row the store would not answer for.
 *
 * The id is kept apart from the reason because the two are read for different
 * things: the id is what decides whether this is news (see `#report`), and the
 * reason is only ever printed.
 */
interface UnreadableRow {
  readonly id: string;
  readonly reason: string;
}

export class BearerAuthenticator implements Authenticator {
  readonly #options: AuthenticatorOptions;
  readonly #now: () => number;
  #cached: readonly LoadedToken[] | null = null;
  #readAt = 0;
  /** Which rows were named last, so a standing fault says it once. */
  #reported: string | null = null;

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async authenticate(authorizationHeader: string | null | undefined): Promise<AuthOutcome> {
    const presented = parseBearer(authorizationHeader);
    if (presented === null) {
      return { ok: false, reason: authorizationHeader ? 'malformed' : 'missing' };
    }

    const fresh = this.#cached !== null && this.#now() - this.#readAt < CACHE_TTL_MS;
    let rows = fresh ? this.#cached! : await this.#reload();
    let matched = find(presented, rows);

    // A miss against a *cached* set is ambiguous: either the credential is
    // wrong, or it is the right one and this process has not seen the rotation
    // or the issue that produced it. One re-read separates the two, and it is
    // what makes a rotated-in token work on its first call rather than after
    // the window. Only a cached comparison can be wrong this way, so a fresh
    // read never pays for a second one — which is what keeps a wrong token from
    // costing a store read per attempt.
    //
    // **And only for something that could be one of these tokens.** A hosted
    // connector presents an OAuth token: the next link in the chain handles it
    // and it can never match a row here. Without that condition the ambiguity
    // above was permanent for such a caller — a healthy endpoint has no static
    // rows, so the match always failed and the "one re-read" fired on every
    // request, re-confirming an empty list at the cost of a bucket read, a YAML
    // parse and a schema validation. The cache never protected anything,
    // because the path that consulted it was the path that always missed.
    if (fresh && matched === null && couldBeProfileToken(presented)) {
      rows = await this.#reload();
      matched = find(presented, rows);
    }

    if (rows.length === 0) {
      // No token has been issued. Fail closed, and distinctly from a wrong one:
      // `lanes link doctor` reads this to say "issue one" rather than "check it".
      return { ok: false, reason: 'not_configured' };
    }

    if (matched === null) return { ok: false, reason: 'invalid' };

    // **Resolved per request, not cached with the value.** Membership is read
    // when a token is minted for an OAuth client (ADR-060) because there is a
    // mint to read it at; a static token has none, so this is the only place
    // the question can be asked. It is what makes `profile members remove`
    // take effect on the next call rather than on the next rotation.
    //
    // A resolver that throws fails closed. The alternative — falling back to
    // "every profile" — would restore exactly the behaviour ADR-068 removes,
    // and would do it precisely when something is already wrong.
    let profiles: readonly string[];
    try {
      profiles = await this.#options.profilesFor(matched.subject);
    } catch {
      return { ok: false, reason: 'invalid' };
    }

    return {
      ok: true,
      principal: machinePrincipal(matched.subject, this.#options.profile, profiles),
    };
  }

  async #reload(): Promise<readonly LoadedToken[]> {
    // Both caches, or neither: the store holds its own decrypted copy, so
    // re-reading without dropping that first re-reads the same stale value.
    this.#options.credentials.refresh?.();

    const rows = await this.#options.tokens();
    const loaded: LoadedToken[] = [];
    const unreadable: UnreadableRow[] = [];
    for (const row of rows) {
      let value: string | null;
      try {
        value = await this.#options.credentials.get(row.ref);
      } catch (error) {
        // **One row may not decide whether anybody can authenticate.**
        //
        // This is `openReconciled`'s rule at the credential level: a sibling it
        // cannot open is skipped rather than allowed to fail the endpoint for
        // the rest. Here the blast radius was larger still, because this link
        // runs *first* in the chain — so a single unreadable row refused OAuth
        // tokens and Lanes-signed keys too, which never got reached. A live
        // endpoint answered every caller with an error, including the token
        // that had been working, until the offending row was revoked.
        //
        // Caught by shape rather than by status, deliberately. The store that
        // produces this throws a bare `Error` whose status survives only as
        // text in the message, so narrowing to a 403 would mean matching on
        // prose. And the broader rule is the one worth holding: whatever stops
        // a row being read, the answer is that the row matches nothing.
        unreadable.push({ id: row.id, reason: firstLine(error) });
        continue;
      }
      // A row whose credential is gone is not an error to report here. It is
      // what a half-finished `secrets push` looks like, and the row simply
      // matches nothing — `doctor` is where that is worth a sentence.
      if (value) loaded.push({ subject: row.subject, value });
    }

    this.#report(unreadable);
    this.#cached = loaded;
    this.#readAt = this.#now();
    return loaded;
  }

  /**
   * Say which rows could not be read, when that set changes.
   *
   * On change rather than on every reload: the window above collapses a burst
   * onto one read, but a grant nobody fixes is still a read every five seconds,
   * and a line each time would bury the one that mattered. Reporting recovery
   * too — the empty set is a change like any other — is what makes the last
   * line about a row the current answer rather than a thing to correlate.
   *
   * **Keyed on which rows, not on what they said, and that is the whole of the
   * fix.** The first version compared the rendered lines, reason included, and
   * on a deployed target it never matched twice: Secret Manager mints a fresh
   * IAM troubleshooter `errorId` into every `PERMISSION_DENIED` message, so the
   * same standing denial arrived as a different string each read and the
   * comparison above was always a change. Eight reloads wrote eight lines. A
   * unit test could not see it — a stub throws the message it was given — so
   * what caught it was reading the log of a real endpoint with an unreadable
   * row, which is what the rehearsal in `CLAUDE.md` is for.
   *
   * The cost is that a row whose *reason* changes while it stays unreadable is
   * not said again. That is the right trade: the set of rows this endpoint
   * cannot honour is the state an operator acts on, and a second reason for a
   * row already named changes nothing they would do.
   */
  #report(unreadable: readonly UnreadableRow[]): void {
    const signature = unreadable.map((row) => row.id).join('\n');
    if (signature === this.#reported) return;
    this.#reported = signature;
    // One line per row, in the shape `not serving <profile>: <reason>` already
    // uses, because the two are read in the same place for the same purpose.
    for (const row of unreadable) {
      this.#options.report?.(`not honouring ${row.id}: ${row.reason}`);
    }
  }

  /**
   * Drop the cached set immediately.
   *
   * The window above already bounds how long a rotation goes unnoticed, so this
   * is an optimisation rather than the mechanism — nothing's correctness may
   * depend on it being called, because for a long time nothing called it.
   */
  invalidateCache(): void {
    this.#cached = null;
  }
}

/**
 * The part of a failure fit to print beside a name.
 *
 * `server/endpoint.ts` trims the same way for the same reason, and this is a
 * copy rather than a shared import because `auth` may not reach that component
 * — see the dependency directions in `architecture.test.ts`.
 */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? '';
}

/**
 * The row a presented token matches, or null.
 *
 * Every row is compared even after one matches. Returning early would make the
 * time taken describe *which* row answered, and the whole point of
 * `tokensMatch` is that a comparison here leaks nothing about the value it is
 * comparing against.
 */
function find(presented: string, rows: readonly LoadedToken[]): LoadedToken | null {
  let found: LoadedToken | null = null;
  for (const row of rows) if (tokensMatch(presented, row.value)) found = row;
  return found;
}

/**
 * Whether a presented credential could be one of *these* tokens at all.
 *
 * `generateProfileToken` mints every one with this prefix, which
 * `secret-detection.ts` and the edge limiter already recognise — so it is exact.
 */
const couldBeProfileToken = (presented: string): boolean =>
  presented.startsWith(PROFILE_TOKEN_PREFIX);

/** What a minted profile token starts with. */
const PROFILE_TOKEN_PREFIX = 'llk_';
/**
 * Mint a profile token: 32 random bytes, base64url, prefixed so it is
 * recognisable in a config file and greppable in a leak.
 */
export function generateProfileToken(): string {
  return `${PROFILE_TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
}
