/**
 * The owner layer — memory, tasks, assets, skills, vault, setup, identity,
 * entities.
 *
 * Eight providers that hold no third-party account: no OAuth, no vendor API, no
 * rate limit anyone else imposes. They are ordinary `defineLocalProvider`
 * registrations, scoped by the same profiles and gated by the same policy
 * evaluation as everything else — which was the claim `docs/detailed/init.md`
 * made and called the real test of the architecture. Since ADR-050 they are also
 * the ones a fresh profile arrives with already granted, because what they reach
 * is the owner's own material and there is no account behind them to protect.
 *
 * Each lives in its own folder beside `google/` and `icloud/`, because that
 * claim is only true if they are providers in the layout as well as in the
 * prose. This file is the one thing they share: a barrel, because several are
 * *constructed* with a store rather than declared as data, so the registry
 * builder needs them together.
 *
 * `memory`, `tasks` and `assets` are the three that hold what the owner keeps,
 * and they divide by what a thing *is* rather than by size: memory is what is
 * true, tasks is what is to be done, assets is a file. That split is the whole
 * of ADR-051, and the routing rule an agent needs is stated in
 * `#server/mcp`'s instructions and in the bundled skill.
 *
 * `setup` is the same shape and holds no account either, but it describes the
 * others rather than holding anything of the owner's. It is read-only by
 * construction — see ADR-019 for why describing setup is not one
 * of ADR-007's control-plane exclusions.
 *
 * `identity` holds no account either. It says who the owner is
 * — the names and addresses to write as them — and is read-only for the reason
 * `setup` is: what it reports is configuration, and configuration is changed in
 * the CLI. It is a provider of its own rather than a section of `setup` so that
 * naming the owner and describing what is connected are two policy decisions
 * instead of one.
 *
 * `entities` is its mirror: who and what *everyone else* is — the people,
 * companies and projects the owner deals with, and their canonical addresses —
 * so that a reference is looked up rather than inferred from whatever was in
 * the conversation. It is writable where `identity` is not, and the two are
 * consistent rather than in tension: identity is configuration, so an agent
 * able to edit it could edit the one fact that stops it signing as the wrong
 * person, while everyone else's details are ordinary owner material that
 * accumulates on the same surface that reads it (ADR-055).
 *
 * All eight ids are reserved (`RESERVED_PROVIDER_IDS`) and still refused by
 * default — the registry has to be built with `allowReserved` to hold them, so a
 * third-party provider cannot claim a namespace whose policy rules would then
 * mean something else. `tasks` cost something to reserve: Google Tasks held that
 * id and was renamed `google_tasks`, because the plain noun belongs to the
 * owner's own list and a manifest already registered under it would have thrown
 * on the second registration rather than shadowing anything.
 */

export { memoryProvider, memoryStorage, assertEntryId, type MemoryEntry } from './memory/provider.ts';
export { tasksProvider } from './tasks/provider.ts';
export {
  ACTIVE_STATUSES,
  TASK_STATUSES,
  taskStorage,
  type Task,
  type TaskStatus,
} from './tasks/store.ts';
export { assetsProvider } from './assets/provider.ts';
export { assetStorage, type Asset } from './assets/store.ts';
export { createSkillsProvider, type SkillsProviderOptions } from './skills/provider.ts';
export { createVaultProvider, type VaultProviderOptions } from './vault/provider.ts';
export { createSetupProvider, type SetupProviderOptions } from './setup/provider.ts';
export { createIdentityProvider, type IdentityProviderOptions } from './identity/provider.ts';
export { entitiesProvider } from './entities/provider.ts';
export { entityStorage, type Attribute, type Entity, type Relation } from './entities/store.ts';
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
