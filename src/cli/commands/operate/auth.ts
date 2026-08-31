import type { ConnectionConfig } from '#profile';
import { credentialResolver, ReauthRequired } from '#connectivity/auth/index.ts';
import type { ResolvedCredential } from '#connectivity/auth/credential.ts';
import { credentialRefFor } from '#registry';
import { announceWorkspace, emit, fail, ok, print, warn } from '../../output.ts';
import { readConnections } from '#profile';
import {
  grantedConnections,
  openWorkspaceRuntime,
  type GlobalFlags,
  type Runtime,
} from '../../runtime.ts';

/**
 * Whether each connection could still authenticate, asked rather than guessed.
 *
 * `doctor` used to answer a version of this from the *age* of a stored
 * credential, which is wrong in both directions: it dates a credential from
 * when its access token was last refreshed, so a healthy connection nobody has
 * called in a fortnight reads as stale, and a grant revoked an hour ago reads
 * as fresh because nothing has tried to use it since.
 *
 * So this attempts the renewal instead. That is the only thing that actually
 * knows, and it is cheap in the case that matters: resolving an OAuth
 * credential short-circuits on the stored `expires_at` (`oauth-authcode/provider.ts`),
 * so a connection whose access token is still live costs no network at all. The
 * cost is one token-endpoint round trip per connection that has genuinely
 * lapsed — which is exactly the set worth asking about.
 *
 * **This command writes.** A successful refresh persists the new token, which on
 * a deployed target is a secret-store version per refreshed connection. That is
 * deliberate — it is the same write the serve path makes, and it warms the token
 * for the next real call — but it is why the read-only wording `check`, `plan`
 * and `doctor` carry does not appear here.
 */

/** What can be said about one connection's ability to authenticate. */
export type AuthVerdict =
  /** Resolved. The vendor accepted it just now, or its access token is still live. */
  | 'ok'
  /** Stored, and cannot be renewed without a person. The signal this exists for. */
  | 'reauth'
  /** Nothing at the credential ref. */
  | 'missing'
  /** A static secret is present, and nothing here can exercise it. */
  | 'stored'
  /** `auth.kind: none` — the owner layer. Can never need signing in. */
  | 'none'
  /** The probe could not complete: a timeout, a network fault, an unexpected throw. */
  | 'unknown';

export interface ConnectionAuth {
  readonly key: string;
  readonly provider: string;
  readonly id: string;
  /** The manifest's `auth.kind`, so a reader can tell why a verdict is what it is. */
  readonly method: string;
  readonly verdict: AuthVerdict;
  /** Whether answering cost a token-endpoint round trip. */
  readonly refreshed: boolean;
  readonly detail?: string;
  readonly fix?: string;
}

/**
 * What the probe observed, before it means anything.
 *
 * Separated from the verdict so the classification can be tested without a
 * network, a credential store, or a runtime — every interesting case here is a
 * question about *mapping*, and the mapping is where the mistakes are.
 */
export type ProbeResult =
  /** A credential came back. `staleAccessToken` is the silent-failure case below. */
  | { readonly outcome: 'resolved'; readonly staleAccessToken: boolean }
  /** The resolver returned `resolveNone()` — there was nothing to resolve. */
  | { readonly outcome: 'none' }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'threw'; readonly error: unknown };

/**
 * One OAuth probe result, as a verdict.
 *
 * The two rules worth stating out loud, because both are ways this feature
 * could lie:
 *
 * **An unexpected throw is `unknown`, never `reauth`.** Only `ReauthRequired`
 * means a person is needed. Anything else — DNS, a 500, a bug in here — must
 * not send someone through a consent screen, and a warning that is wrong once
 * is a warning that gets scrolled past every time after.
 *
 * **A resolved token is not automatically `ok`.** `upstreamAccessToken` hands
 * back the *stale* access token when there is no refresh token to renew with,
 * and again when a refresh returns no `access_token`. Both are deliberate on
 * the serve path, where letting the vendor's own 401 surface is the truthful
 * instruction — but a health check that reported them as working would be
 * saying the opposite of what the next real call will find. So the stored
 * expiry is checked here rather than that behaviour being changed.
 */
export function classifyOAuth(result: ProbeResult): AuthVerdict {
  switch (result.outcome) {
    case 'resolved':
      return result.staleAccessToken ? 'reauth' : 'ok';
    case 'none':
      return 'missing';
    case 'timeout':
      return 'unknown';
    case 'threw':
      return result.error instanceof ReauthRequired ? 'reauth' : 'unknown';
  }
}

/**
 * How many connections to probe at once.
 *
 * Small on purpose. The work is mostly waiting on token endpoints, so some
 * concurrency is free, but a profile with twenty Google connections hitting one
 * endpoint at once is a rate limit rather than a speed-up.
 */
const CONCURRENCY = 6;

/**
 * How long one connection may take before it is reported as `unknown`.
 *
 * `refreshDirectly` takes no `AbortSignal`, so this races rather than cancels —
 * the request finishes into nothing. That is acceptable for a read-shaped
 * command and avoids threading a signal through the refresh path for the
 * benefit of one caller.
 */
const PER_CONNECTION_TIMEOUT_MS = 8_000;

/** `expires_at` from a stored OAuth blob, or null when it is not one. */
function storedExpiry(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { expires_at?: number };
    return typeof parsed.expires_at === 'number' ? parsed.expires_at : null;
  } catch {
    return null;
  }
}

export interface AuthFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  /** Narrow to one connection, by `provider.id`. A filter, not a second subject. */
  readonly connection?: string | undefined;
}

/**
 * Every connection's verdict, probed concurrently.
 *
 * Exported because `doctor` asks the same question and must not answer it a
 * second, differently-wrong way — that divergence is the bug this replaced.
 */
export async function probeConnections(
  runtime: Runtime,
  connections: readonly ConnectionConfig[],
  forSelection: (command: string) => string,
): Promise<ConnectionAuth[]> {
  const resolve = credentialResolver(runtime.registry, runtime.credentials);

  const probe = async (
    connection: ConnectionConfig,
  ): Promise<ConnectionAuth> => {
    const key = `${connection.provider}.${connection.id}`;
    const manifest = runtime.manifestFor(connection.provider);
    const method = manifest?.auth.kind ?? 'unknown';
    const base = { key, provider: connection.provider, id: connection.id, method };

    // A provider holding nothing to authenticate with can never need signing
    // in, and saying so is more useful than saying nothing: it is the whole
    // owner layer, and "why is memory not checked" is a real question.
    if (!manifest || manifest.auth.kind === 'none') {
      return { ...base, method: 'none', verdict: 'none', refreshed: false };
    }

    const ref = credentialRefFor(connection, manifest);
    if (!ref) return { ...base, verdict: 'none', refreshed: false };

    const missing = (): ConnectionAuth => ({
      ...base,
      verdict: 'missing',
      refreshed: false,
      detail: `Nothing stored at ${ref}.`,
      fix: forSelection(`lanes link connect ${key}`),
    });

    if (!(await runtime.credentials.has(ref))) return missing();

    // Everything that is not authcode OAuth is a secret sitting in the store.
    // There is nothing to renew and no cheap way to exercise it, so presence is
    // the whole of what can be said — and `strategy` in particular *must* take
    // this path, because `credentialResolver` refuses it unconditionally (it
    // signs its own requests) and routing it through would manufacture a
    // failure that is not there.
    if (manifest.auth.kind !== 'oauth') {
      return { ...base, verdict: 'stored', refreshed: false };
    }

    const before = storedExpiry(await runtime.credentials.get(ref));
    const lapsed = before !== null && before <= Date.now();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      resolve(connection.provider, connection.id).then(
        (credential: ResolvedCredential): ProbeResult =>
          credential.kind === 'none'
            ? { outcome: 'none' }
            : { outcome: 'resolved', staleAccessToken: false },
        (error: unknown): ProbeResult => ({ outcome: 'threw', error }),
      ),
      new Promise<ProbeResult>((settle) => {
        timer = setTimeout(() => settle({ outcome: 'timeout' }), PER_CONNECTION_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);

    // The silent-failure check. An expiry that is *still* in the past after
    // resolving means the resolver went out and came back with nothing better,
    // which is the case `classifyOAuth` documents.
    const after = storedExpiry(await runtime.credentials.get(ref));
    const stillLapsed = after !== null && after <= Date.now();

    const settled: ProbeResult =
      result.outcome === 'resolved'
        ? { outcome: 'resolved', staleAccessToken: stillLapsed }
        : result;

    const verdict = classifyOAuth(settled);
    const detail =
      result.outcome === 'threw' && result.error instanceof Error
        ? result.error.message
        : result.outcome === 'timeout'
          ? `Timed out after ${PER_CONNECTION_TIMEOUT_MS / 1000}s.`
          : settled.outcome === 'resolved' && settled.staleAccessToken
            ? 'The stored access token is expired and could not be renewed.'
            : undefined;

    return {
      ...base,
      verdict,
      // Whether answering cost a round trip: a live token means the resolver
      // short-circuited and never went out.
      refreshed: lapsed,
      ...(detail ? { detail } : {}),
      ...(verdict === 'reauth' || verdict === 'missing'
        ? { fix: forSelection(`lanes link connect ${key}`) }
        : {}),
    };
  };

  return mapWithLimit(connections, CONCURRENCY, probe);
}

export async function auth(flags: AuthFlags): Promise<void> {
  const runtime = await openWorkspaceRuntime(flags);

  try {
    const { profile, target } = runtime.resolution;
    const forSelection = (command: string) => `${command} --workspace ${target}`;

    // Every connection the workspace holds, not the ones one profile grants.
    // Whether an account can still authenticate is a fact about the account
    // (ADR-057), and scoping it to a profile's grants meant an account that had
    // just been connected could not be checked until somebody granted it —
    // which is exactly the moment you want to check.
    //
    // `--profile` narrows to what that profile can reach, because "can the
    // things this profile uses still sign in" is also a real question.
    const all = flags.profile === undefined
      ? (await readConnections(runtime.resolution.workspaceRoot)).connections
      : grantedConnections(runtime);

    const wanted = flags.connection;
    const connections = wanted ? all.filter((c) => `${c.provider}.${c.id}` === wanted) : all;

    if (wanted && connections.length === 0) {
      throw new Error(
        `No connection "${wanted}" in workspace ${target}. Run: ${forSelection('lanes link connection list')}`,
      );
    }

    const results = await probeConnections(runtime, connections, forSelection);
    const needsSomeone = results.filter((r) => r.verdict === 'reauth' || r.verdict === 'missing');

    // Always zero, and this is load-bearing rather than an oversight: the
    // desktop app discards stdout when the CLI exits non-zero, which is exactly
    // why it cannot read `doctor`. A connection needing a person is the answer
    // this command was asked for, not a failure to produce one.
    return emit(flags.json, { profile, target, ok: needsSomeone.length === 0, connections: results }, () => {
      announceWorkspace(runtime.resolution);

      for (const result of results) {
        const line = `${result.key} — ${describe(result.verdict)}`;
        if (result.verdict === 'reauth') print(fail(`${line}\n      ${result.fix}`));
        else if (result.verdict === 'missing') print(warn(`${line}\n      ${result.fix}`));
        else print(ok(line));
      }

      if (needsSomeone.length > 0) {
        print();
        print(fail(`${needsSomeone.length} connection(s) need you to sign in again`));
      }
    });
  } finally {
    await runtime.close();
  }
}

function describe(verdict: AuthVerdict): string {
  switch (verdict) {
    case 'ok':
      return 'authenticated';
    case 'reauth':
      return 'signed out, and cannot renew itself';
    case 'missing':
      return 'no credential stored';
    case 'stored':
      return 'credential stored, not exercised';
    case 'none':
      return 'needs no credential';
    case 'unknown':
      return 'could not be checked';
  }
}

/**
 * `Promise.all` with a ceiling, in the ten lines it takes.
 *
 * A pool rather than chunks: chunking would make every batch wait for its
 * slowest member, which is the shape this command is trying to avoid.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
