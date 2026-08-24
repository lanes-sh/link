/**
 * Secrets — one component, one format, two stores that must never become one.
 *
 * "Secrets" means two different things here, and collapsing them is the most
 * dangerous mistake available in this codebase:
 *
 *   1. **System credentials** (`./system.ts`) — OAuth refresh tokens, OAuth app
 *      client secrets, the profile API token. These authorise the system
 *      itself. They are NEVER reachable from MCP, in any form, for any client.
 *      If an agent could read the Gmail refresh token it would simply call
 *      Google directly, and the entire policy layer would become decorative.
 *
 *   2. **Vault items** (`./vault.ts`) — the owner's own passwords and API keys,
 *      which an agent may legitimately be granted access to, one at a time,
 *      under policy.
 *
 * They used to be two components with two implementations of the same
 * AES-256-GCM document, two write-then-rename routines, and two copies of "read
 * the key from an env var, else a sibling file, else mint one". That
 * duplication was worth removing and is gone: `./document.ts` is the single
 * format, and both stores are built on it with the same adapters.
 *
 * What is deliberately *not* shared is the part that matters — a separate
 * document, a separate key, a separate environment variable. One master secret
 * reused across purposes turns any single compromise into a total one.
 * Two tests hold that line, each living with its own subject:
 * `#dispatch`'s `control-plane.test.ts` asserts a `ProviderContext` has no path
 * to a full store, and `#providers/vault`'s own test asserts that provider
 * never so much as names one.
 */

/**
 * A key into a secret store, e.g. `google/client_secret`, `gmail/main`,
 * `profile/token`. Config files carry these references; never values.
 */
export type SecretRef = string;

/** Matches `segment/segment[/segment...]`, lowercase, no traversal. */
const SECRET_REF_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+$/;

export function isValidSecretRef(ref: string): boolean {
  return SECRET_REF_PATTERN.test(ref);
}

export function assertValidSecretRef(ref: string): void {
  if (!isValidSecretRef(ref)) {
    throw new Error(
      `Malformed secret reference: ${JSON.stringify(ref)}. ` +
        'Expected lowercase segments separated by "/", e.g. "acme/main".',
    );
  }
}

/**
 * The full store. Held by the CLI and by the dispatch layer; never handed to a
 * provider, and never exposed through MCP.
 *
 * `list` returns keys only. There is no operation that enumerates values.
 */
export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  has(ref: SecretRef): Promise<boolean>;
  delete(ref: SecretRef): Promise<void>;
  list(prefix?: string): Promise<SecretRef[]>;
  /**
   * Drop whatever is held in memory so the next read reaches the store.
   *
   * Optional because most adapters hold nothing to drop. It exists for the one
   * caller that has to see a value it did not write itself: the endpoint
   * checking a bearer token that `lanes link token rotate` replaced from a
   * different process. The file adapter keeps the whole decrypted document
   * cached, so without this a re-read is served the copy it already had.
   */
  refresh?(): void;
}

/**
 * What a provider sees: read-only, and only the references belonging to the one
 * connection it was invoked for.
 *
 * A Gmail provider handling `gmail.main` cannot read `gmail.side`'s refresh
 * token, cannot read `google/client_secret` unless its connection declares it,
 * and cannot enumerate anything.
 */
export interface ScopedSecrets {
  get(ref: SecretRef): Promise<string | null>;
  has(ref: SecretRef): Promise<boolean>;
}

/**
 * Restrict a store to an explicit allowlist of references.
 *
 * Allowlist rather than prefix match: a provider's reachable secrets are exactly
 * what its connection declares. A prefix rule would silently widen as new refs
 * appear under the same prefix.
 */
export function scopeSecrets(
  base: SecretStore,
  allowed: readonly SecretRef[],
): ScopedSecrets {
  const allowlist = new Set(allowed);

  const check = (ref: SecretRef): void => {
    if (!allowlist.has(ref)) {
      // Deliberately does not reveal whether the ref exists in the underlying
      // store — an out-of-scope ref is indistinguishable from a missing one.
      throw new Error(`Secret ${JSON.stringify(ref)} is not in scope for this connection`);
    }
  };

  return {
    async get(ref) {
      check(ref);
      return base.get(ref);
    },
    async has(ref) {
      check(ref);
      return base.has(ref);
    },
  };
}

// ---------------------------------------------------------------------------
// The two stores
// ---------------------------------------------------------------------------

export {
  createBlobSecretStore,
  createFileSecretStore,
  generateCredentialKey,
  type BlobSecretsOptions,
  type FileSystemSecretsOptions,
} from './system.ts';

export {
  DEFAULT_SECRET_REF as VAULT_DOCUMENT_REF,
  VAULT_ITEM_ID,
  VAULT_KEY_ENV,
  VAULT_KEY_REF,
  assertItemId,
  createBlobVaultStore,
  createFileVaultStore,
  createMemoryVaultStore,
  createSecretVaultStore,
  generateVaultKey,
  type BlobVaultStoreOptions,
  type FileVaultStoreOptions,
  type SecretVaultStoreOptions,
  type VaultItem,
  type VaultStore,
} from './vault.ts';

export { generateKey, type DocumentIO } from './document.ts';
