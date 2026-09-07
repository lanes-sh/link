import { hkdfSync } from 'node:crypto';
import { KEY_BYTES, type KeySource } from './document.ts';

/**
 * One vault key per workspace, derived rather than stored.
 *
 * **This is the isolation bug ADR-070 named and nothing fixed.**
 * `LANES_LINK_VAULT_KEY` is read once for the whole process
 * (`envOnlyKeySource`), which is exactly right for a self-hosted deploy serving
 * one workspace and exactly wrong for a Lanes-hosted one serving many: every
 * tenant's vault would be sealed under one key, so any workspace that could
 * reach another's ciphertext could read it. The seam has been on
 * `createBlobVaultStore` and `createSecretVaultStore` since they were written
 * and nothing ever passed one.
 *
 * **Derived, not stored, and that is the whole design.** A key per workspace in
 * Secret Manager would be a second thing to provision, rotate and lose — and
 * losing one makes that workspace's vault permanently unreadable while looking
 * like it worked. HKDF gives the same separation from one master key: the same
 * workspace always derives the same key, two workspaces never derive the same
 * one, and knowing one tells you nothing about another or about the master.
 *
 * **The workspace id is the salt, and it is not a secret.** It does not have to
 * be: HKDF's salt is a domain separator, not a second key. What must stay
 * secret is the master, and it is the one value this reads from the
 * environment.
 *
 * **Which workspaces get one is not this component's decision.** `secrets` may
 * not import `deployments` (`src/architecture.test.ts`), and knowing that a
 * managed workspace is spelled `lanes://` would be exactly that knowledge. So
 * this takes a workspace name and derives a key; the caller decides whether
 * there is one. A self-hosted deploy passes nothing and keeps the process key
 * it always had.
 */

/** The master. Per environment and per deployment; never per workspace. */
const MASTER = 'LANES_LINK_VAULT_KEY';

/**
 * What each derived key is for, bound into the derivation.
 *
 * Two keys for one workspace must not be the same bytes. The vault and the
 * credential store hold different things under different threat models — a
 * vault item is the owner's own secret, a credential is an account's refresh
 * token — and a bug that crossed them would decrypt one with the other's key
 * and report corruption rather than a mistake.
 */
const PURPOSES = {
  vault: 'lanes-link/vault/v1',
  credentials: 'lanes-link/credentials/v1',
} as const;

export type DerivedPurpose = keyof typeof PURPOSES;

function decodeMaster(raw: string): Uint8Array {
  // Base64 first, hex second, matching what `document.ts` accepts, so a key
  // written for the single-workspace path is the same key here.
  const trimmed = raw.trim();
  const decoded = /^[0-9a-fA-F]+$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (decoded.length < KEY_BYTES) {
    throw new Error(
      `${MASTER} decodes to ${decoded.length} bytes; a vault master key is at least ` +
        `${KEY_BYTES}. Generate one with "openssl rand -base64 32".`,
    );
  }
  return new Uint8Array(decoded);
}

/**
 * A key source for one workspace and one purpose.
 *
 * The caller decides there is a workspace to derive for; see the note above
 * about why that decision is not made here.
 */
export function workspaceKey(
  workspace: string,
  purpose: DerivedPurpose,
  env: Record<string, string | undefined> = process.env,
): KeySource {
  return async () => {
    const master = env[MASTER];
    if (!master) {
      throw new Error(
        `${MASTER} is required for a hosted workspace's vault. It is the master every ` +
          'workspace\'s key is derived from, so it is one value for the deployment rather ' +
          'than one per tenant. Generate it with "openssl rand -base64 32".',
      );
    }
    // Synchronous, and deliberately not cached here: the vault stores already
    // memoise the key they were handed (`this.#key ??= await this.#keySource()`),
    // so a cache at this level would be a second copy of the same value with a
    // second lifetime — and one keyed by workspace is exactly the thing that
    // must not be shared between them.
    return new Uint8Array(
      hkdfSync('sha256', decodeMaster(master), workspace, PURPOSES[purpose], KEY_BYTES),
    );
  };
}

/** The vault's key for one workspace. The common case, named. */
export const workspaceVaultKey = (
  workspace: string,
  env: Record<string, string | undefined> = process.env,
): KeySource => workspaceKey(workspace, 'vault', env);
