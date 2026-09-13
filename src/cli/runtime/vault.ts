import {
  soleGrantFor, layout, vaultRef, workspacePath } from '#profile';
import { VAULT_KEY_REF, type SecretStore, type StoredKey } from '#secrets';
import {
  createBlobVaultStore,
  createFileVaultStore,
  createSecretVaultStore,
  type VaultStore,
} from '#providers/owner.ts';
import type { StorageFactory, TargetInput } from '#deployments/target.ts';

/**
 * Which document the vault is, and where it lives.
 *
 * Its own file for the reason `#deployments/knowledge.ts` is: `open.ts` is a
 * composition root, and "which of three backends holds one encrypted document"
 * is a decision with its own reasoning rather than a step in assembling a
 * runtime. Knowledge made the same move and could go to `deployments`; this one
 * cannot, because the vault store is a provider and `deployments` may not import
 * `providers` (`src/architecture.test.ts`). So it stops here, one level up.
 */

/**
 * The vault's encrypted document, wherever this target keeps it.
 *
 * Defaults to `file`, so a profile written before ADR-014 needs no change and a
 * local run needs no vault configuration at all. `blob` exists because the file
 * adapter was unconditional before: a deployed instance wrote its vault to a
 * container filesystem, and every item in it was discarded by the next
 * revision without an error to say so.
 */
export function openVault(
  input: TargetInput,
  storage: StorageFactory,
  credentials: SecretStore,
): VaultStore {
  const { declared, config, root } = input;
  const vault = declared.vault ?? { adapter: 'file' as const };

  // The vault connection this profile grants (ADR-059). `main` when it grants
  // none, which keeps a profile that denied the vault opening against the same
  // document every other profile uses rather than inventing a second one.
  const connection = soleGrantFor(config, 'lanes_vault') ?? 'main';

  // Where the key is, for anything that is not the revision.
  //
  // `deploy` mints it into the target's own credential store at `vault/key`
  // (`#deployments/prepare.ts`) and mounts it on the revision as
  // `LANES_LINK_VAULT_KEY` via `--set-secrets` (`#deployments/bootstrap.ts`).
  // The revision therefore never reaches this: the environment is checked first
  // and it always answers there.
  //
  // The CLI is the caller that had nothing. It holds `credentials` — the very
  // store `vault/key` is in, and the one it read every OAuth refresh token out
  // of on the way here — and then refused to open the vault for want of a key
  // sitting in the store it had just finished reading. ADR-014 says
  // the key comes from the environment and nothing else, which is what that
  // refusal was; ADR-022 is why relaxing it gives nothing away. Reading
  // `vault/key` from here needs exactly the access that already hands over
  // Gmail, Drive and iCloud, and the vault is the smaller asset — that ADR's
  // own words for why it stopped living behind the taller fence.
  //
  // A `file` vault gets none of this. It mints its own key beside the document
  // at 0600 and there is no ref to read.
  const stored: StoredKey = {
    ref: VAULT_KEY_REF,
    get: (ref) => credentials.get(ref),
    describeStore: "this target's credential store",
  };
  const remedy = `lanes link deploy --workspace ${input.target}`;

  switch (vault.adapter) {
    case 'file':
      return createFileVaultStore({
        path: workspacePath(root, vault.path ?? layout.vault(config.instance.profile, connection)),
      });

    case 'secret':
      // The document is sealed under LANES_LINK_VAULT_KEY before it gets here,
      // so the credential store holds ciphertext it cannot read. Separate
      // document, separate key, separate environment variable — the backend
      // was never what kept the two stores apart. ADR-022.
      //
      // Named per connection, like the file adapter. A `ref` written by hand
      // still wins, because a deployment that already seals under one name has
      // to keep opening it — but the default carries the instance, so two
      // profiles granting different vaults share nothing. Without this only
      // `file` honoured ADR-059 and every deployed workspace, which uses this
      // adapter or `blob`, had one document behind every vault connection:
      // ADR-059 calls that the worst of the three collisions, because the wrong
      // answer is a credential.
      return createSecretVaultStore({
        store: credentials,
        ref: vaultRef(declared, config),
        stored,
        remedy,
      });

    case 'blob':
      return createBlobVaultStore({
        store: storage(),
        key: vault.path ?? layout.vaultKey(connection),
        stored,
        remedy,
      });
  }
}
