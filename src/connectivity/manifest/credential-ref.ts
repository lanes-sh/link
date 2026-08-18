import type { ProviderManifest } from './provider.ts';

/**
 * Where this provider keeps the credential for one connection.
 *
 * The single authority, because there used to be two that disagreed: reconcile
 * derived `<provider>/<id>` and never read the manifest, while the request
 * authorizer read the manifest and never derived. A provider declaring
 * `credential_ref: mything/api_key` was therefore reported unauthorized forever
 * — `doctor` told you to run `connect`, and `connect` did not help.
 *
 * Four cases, in precedence order. The caller applies a fifth ahead of them all:
 * a `credential_ref` on the *connection* is a hand placement and wins outright.
 */
export function credentialRefForConnection(
  manifest: ProviderManifest,
  connectionId: string,
): string | undefined {
  const auth = manifest.auth;

  if (auth.kind === 'none') return undefined;

  // OAuth tokens are always per provider. `app` names the shared *client*, not
  // where tokens land: Gmail and Drive authorise against one Google client but
  // hold separate tokens, because they were granted different scopes, and
  // pointing both at one ref would have the second connect silently narrow the
  // first.
  if (auth.kind === 'oauth') return `${manifest.id}/${connectionId}`;

  if (auth.kind === 'strategy') return auth.credential_ref ?? `${manifest.id}/${connectionId}`;

  if (auth.credential_ref) return auth.credential_ref;
  return `${auth.app ?? manifest.id}/${connectionId}`;
}

/**
 * Which of this connection's references get written while serving a request,
 * rather than only by a command the operator ran.
 *
 * Nothing about a credential says whether it is rewritten in flight, and the
 * one place that knows — `CredentialOAuthProvider` — keeps its refs private.
 * So a deployed revision was granted read on the store and write on nothing,
 * which held right up until an access token expired: the refresh persists, and
 * the request that triggered it failed on a store it was only allowed to read.
 *
 * Kept beside `credentialRefForConnection` because it is the same question
 * asked for a different purpose, and answering it two files apart is how those
 * two disagreed the first time. `deployments/grants.test.ts` pins this against
 * what a deploy actually binds.
 */
export function rotatableCredentialRefs(
  manifest: ProviderManifest,
  connectionId: string,
): readonly string[] {
  const auth = manifest.auth;
  if (auth.kind !== 'oauth') return [];

  // The token blob, rewritten by `saveTokens` on every refresh. Always, and it
  // is the one that matters: this is the hot path of an ordinary read.
  const refs = [`${manifest.id}/${connectionId}`];

  // A dynamically registered client, rewritten by `saveClientInformation` if
  // the SDK ever re-registers mid-flight. Rare enough that it has never been
  // seen, and unbound it fails exactly the same way — the cost of listing it is
  // one binding on a secret that already exists.
  //
  // Never for `manual`: that client is the operator's, shared across every
  // connection using the same `oauth_apps` entry, and a revision has no
  // business rewriting it.
  if (auth.registration !== 'manual') refs.push(`${manifest.id}/client`);

  return refs;
}
