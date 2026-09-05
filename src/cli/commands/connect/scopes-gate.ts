import { discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/client';
import type { ProviderManifest } from '#connectivity';
import { progress, prose, style, warn } from '../../output.ts';
import type { Prompter } from '../../prompt.ts';
import { describeScopes, shortScope } from '../../scopes.ts';

/**
 * Saying what a grant will be able to do, while declining still costs nothing.
 *
 * Its own file because both halves of `authorise` run it — the SDK path and the
 * direct one — and because the file it came out of had grown past the budget.
 * The seam is real: everything here happens before any client is chosen and
 * before any listener is opened.
 */

/**
 * Warn when a manifest's pinned scopes have drifted from the server's.
 *
 * Pinning is deliberate — it stops a vendor widening a grant by editing its own
 * metadata — but a pinned list is a list that can go stale, and both directions
 * of staleness are worth different words:
 *
 * - the server declares a scope we do not request → calls fail, and Google's
 *   servers say only "The caller does not have permission", which points
 *   nowhere near the cause. This is the failure that cost an afternoon.
 * - we request one it no longer declares → probably harmless, possibly a scope
 *   that has been withdrawn; worth seeing, not worth stopping for.
 *
 * Advisory in both directions. Discovery failing must not block a connect that
 * would otherwise work, so a broken probe is silent.
 */
async function reportScopeDrift(pinned: readonly string[], serverUrl: string): Promise<void> {
  let advertised: readonly string[] = [];

  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
    advertised = (metadata as { scopes_supported?: string[] }).scopes_supported ?? [];
  } catch {
    return;
  }

  if (advertised.length === 0) return;

  const missing = advertised.filter((scope) => !pinned.includes(scope));
  const extra = pinned.filter((scope) => !advertised.includes(scope));

  if (missing.length > 0) {
    progress('');
    prose(
      `${new URL(serverUrl).host} advertises ${missing.length} scope(s) not requested: ` +
        `${missing.map(shortScope).join(', ')}.`,
      { paint: style.dim, to: progress },
    );
    prose(
      '  Deliberate — an advertised scope is not necessarily a required one, and these are broader than the docs ask for. Worth revisiting only if calls fail on permission.',
      { paint: style.dim, to: progress },
    );
  }

  if (extra.length > 0) {
    progress('');
    prose(`Note: ${extra.map(shortScope).join(', ')} is no longer declared by the server.`, {
      paint: style.dim,
      to: progress,
    });
  }
}

/**
 * Show what is about to be granted, and stop on the broad ones.
 *
 * The consent screen that follows lists the same scopes in the vendor's own
 * wording, where "Read, compose, send, and permanently delete all your email"
 * sits in a list of five and reads like boilerplate. This is the same
 * information a step earlier, in our words, with the account still unconnected
 * — the last point where declining costs nothing.
 */
export async function confirmScopes(
  manifest: ProviderManifest,
  serverUrl: string,
  prompter: Prompter,
  acceptBroadScopes: boolean,
  /**
   * What will actually be asked for, which is not always what the manifest
   * declares: a brokered flow appends the broker's identity scopes. Showing the
   * manifest's set instead would put a scope on the vendor's screen that this
   * gate never mentioned, which is precisely the surprise it exists to prevent.
   */
  scopes: readonly string[] = manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [],
): Promise<boolean> {
  if (manifest.auth.kind !== 'oauth' || scopes.length === 0) return true;

  await reportScopeDrift(scopes, serverUrl);

  const described = describeScopes(scopes);

  progress('');
  progress(`${manifest.name} will be granted:`);
  for (const { scope, meaning, broad } of described) {
    const name = broad ? style.bold(shortScope(scope)) : shortScope(scope);
    progress(`  ${broad ? '!' : '·'} ${name}${meaning ? style.dim(`  — ${meaning}`) : ''}`);
  }

  if (!described.some((entry) => entry.broad)) {
    progress('');
    return true;
  }

  // Why the broad ones cannot simply be dropped — otherwise the obvious next
  // question is why we ask instead of asking for less.
  progress('');
  prose(
    'The marked scopes are broader than this provider needs. Grant them only if you ' +
      'mean to — policy can restrict what an agent calls, but it cannot un-grant a token.',
    { prefix: warn(''), to: progress },
  );
  prose(
    '  Policy still applies: only capabilities you allow are reachable, and every call is audited.',
    { paint: style.dim, to: progress },
  );
  progress('');

  // Answered ahead of time, by a person, in their own shell. The flag is long
  // enough that repeating it is a deliberate act, and it lands in the history of
  // whoever typed it — which is the property that matters, since the point of
  // this gate is that the decision does not originate with the agent.
  if (acceptBroadScopes) {
    progress(style.dim('Broad scopes accepted with --accept-broad-scopes.'));
    return true;
  }

  // Fail closed rather than defaulting to no. A non-interactive run cannot
  // answer, and inventing an answer here would remove the last point at which
  // declining is free — the vendor's own consent screen is next, where the same
  // sentence sits in a list of five and reads like boilerplate.
  if (!prompter.interactive) {
    throw new Error(
      `${manifest.name} asks for scopes broader than it needs, and this run is non-interactive.\n` +
        `  Nothing was authorised. Re-run in a terminal, or add --accept-broad-scopes if you mean to grant them.`,
    );
  }

  return prompter.confirm('Authorise with these scopes?', false);
}

