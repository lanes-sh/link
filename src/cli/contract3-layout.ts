import { LEGACY_DATA_DIR, LEGACY_WORKSPACE_FILE } from '#profile';

/**
 * Where contract 3 put things, frozen.
 *
 * `#profile`'s `layout` describes where things live *now*. A migration lives
 * between two layouts and must not ask it: `contract3.ts` migrates to this one
 * and `contract4.ts` migrates away from it, so both need it spelled somewhere
 * that will not move when the live one does. Asking `layout` made the contract-3
 * migration write a contract-4 tree, skipping the step contract 4 was about to
 * take and leaving nothing for it to find.
 *
 * One module rather than a copy in each, for the reason `layout.ts` exists: the
 * credential path was spelled in three files and they have to agree forever.
 */
/**
 * The owner layer's ids through contract 3, before the `lanes_` prefix.
 *
 * Spelled here for the reason every other path in this file is: a migration
 * reads the shape it is migrating *from*. `RESERVED_PROVIDER_IDS` is the live
 * list and is `lanes_memory` now, so asking it whether a contract-2 row is
 * owner-layer answers no for every one of them.
 */
export const C3_OWNER_PROVIDERS: readonly string[] = [
  'memory',
  'tasks',
  'assets',
  'skills',
  'vault',
  'setup',
  'identity',
  'entities',
];

export const C3 = {
  /** The registry, before it became `workspaces.yaml`. */
  workspace: LEGACY_WORKSPACE_FILE,
  /** A profile's declaration, before it moved inside its own directory. */
  profile: (profile: string): string => `profiles/${profile}.yaml`,
  credentials: (): string => `${LEGACY_DATA_DIR}/credentials.enc`,
  state: (): string => `${LEGACY_DATA_DIR}/state.kv`,
  audit: (): string => `${LEGACY_DATA_DIR}/audit.log`,
  providers: (): string => `${LEGACY_DATA_DIR}/providers.d`,
  vault: (connection: string): string => `${LEGACY_DATA_DIR}/vault.d/${connection}.enc`,
  skills: (connection: string): string => `${LEGACY_DATA_DIR}/skills.d/${connection}`,
} as const;
