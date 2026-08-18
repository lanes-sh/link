/**
 * The owner layer — memory, skills, vault.
 *
 * Three providers that hold no third-party account: no OAuth, no vendor API, no
 * rate limit anyone else imposes. They are ordinary `defineLocalProvider`
 * registrations, configured by the same `lanes link connect <provider>`, scoped by the
 * same profiles, and gated by the same policy evaluation as everything else —
 * which was the claim `docs/detailed/init.md` made and called the real test of the
 * architecture.
 *
 * They live in `./memory/`, `./skills/` and `./vault/`, beside `google/` and
 * `icloud/`, because that claim is only true if they are providers in the
 * layout as well as in the prose. This file is the one thing they share: a
 * barrel, because each is *constructed* with a store rather than declared as
 * data, so `#profile`'s registry builder needs all three together.
 *
 * `setup` joined them later and is the same shape: it holds no account either,
 * and it describes the other three rather than reaching anything. It is
 * read-only by construction — see ADR-019 for why describing setup is not one
 * of ADR-007's control-plane exclusions.
 *
 * The ids `memory`, `skills`, `vault`, and `setup` are reserved (`RESERVED_PROVIDER_IDS`)
 * and still refused by default — the registry has to be built with
 * `allowReserved` to hold them, so a third-party provider cannot claim a
 * namespace whose policy rules would then mean something else.
 */

export { memoryProvider, memoryStorage, assertEntryId, type MemoryEntry } from './memory/provider.ts';
export { createSkillsProvider, type SkillsProviderOptions } from './skills/provider.ts';
export { createVaultProvider, type VaultProviderOptions } from './vault/provider.ts';
export { createSetupProvider, type SetupProviderOptions } from './setup/provider.ts';
export { planAll, planFor, type PlanContext, type ProviderPlan } from './setup/plan.ts';
// The vault's *store* is not here: it is `#secrets`, beside the system
// credential store it must never become. What lives in `./vault/` is the
// provider — the capabilities, and the rule that each item is its own.
export {
  assertItemId,
  createBlobVaultStore,
  createFileVaultStore,
  createMemoryVaultStore,
  createSecretVaultStore,
  generateVaultKey,
  VAULT_ITEM_ID,
  type BlobVaultStoreOptions,
  type SecretVaultStoreOptions,
  type FileVaultStoreOptions,
  type VaultItem,
  type VaultStore,
} from '#secrets';
