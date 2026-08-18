import { credentialRefForConnection, type ProviderManifest } from '#connectivity';
import type { ProviderRegistry } from '#registry';
import type { SecretStore } from '#secrets';
import type { ResolvedCredential } from '../credential.ts';

/**
 * RFC 7617 Basic — a username and a password, stored as one string.
 *
 * `user:pass`, split on the *first* colon, which is lossless because the spec
 * forbids a colon in the userid. Storing the pair exactly as the header carries
 * it means nothing has to agree about a JSON shape.
 */
export function resolveBasic(value: string, ref: string, providerId: string): ResolvedCredential {
  const colon = value.indexOf(':');
  if (colon === -1) {
    throw new Error(
      `The credential at ${ref} is not a "username:password" pair, which basic auth requires. ` +
        `Re-run: lanes link connect ${providerId}`,
    );
  }

  return { kind: 'basic', username: value.slice(0, colon), password: value.slice(colon + 1) };
}

export function attachBasic(
  credential: Extract<ResolvedCredential, { kind: 'basic' }>,
  request: Request,
): void {
  // `btoa` is wrong here twice: it throws outright above U+00FF, and below it
  // silently encodes Latin-1 bytes where RFC 7617 requires UTF-8 — so a
  // password with an umlaut produced a header that was well-formed, accepted by
  // the type system, and rejected by the server.
  request.headers.set(
    'authorization',
    `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`,
  );
}

/**
 * The username and password for a connection, for a protocol that wants them as
 * a pair rather than as a header.
 *
 * IMAP and DAV take this closure as a constructor option. It is bound to one
 * provider and one connection and takes no arguments, so a connector holding it
 * cannot name a *different* account's credential — the same boundary
 * `scopeSecrets` enforces with an allowlist, reached here by having nothing to
 * pass.
 */
export async function basicCredential(
  manifest: ProviderManifest,
  connectionId: string,
  secrets: SecretStore,
): Promise<{ username: string; password: string }> {
  const { credentialResolver } = await import('../resolve.ts');
  const registry = { manifest: () => manifest } as unknown as ProviderRegistry;
  const resolved = await credentialResolver(registry, secrets)(manifest.id, connectionId);

  if (resolved.kind !== 'basic') {
    throw new Error(
      `Provider "${manifest.id}" needs a username and password, but its auth resolves to "${resolved.kind}".`,
    );
  }

  return { username: resolved.username, password: resolved.password };
}

/** Re-exported so the factory can derive a ref without reaching for the manifest module. */
export { credentialRefForConnection };
