/**
 * A profile: its file, its schema, and where it lives on disk.
 *
 * **A profile is a selection, not an inventory.** Since contract 3 the accounts
 * live in the workspace's `connections.yaml` and a profile names the ones it
 * grants (ADR-057), so profiles share an endpoint, its token, the credential
 * store, and any connection they both select. What they do not share is the
 * grant: two profiles on one mailbox can permit entirely different things
 * (ADR-058). This component owns everything about what a profile *is* — the
 * YAML contract, the loader that validates it, the join onto the workspace's
 * connections, and the resolution that finds them.
 *
 * What it deliberately does not own: which providers exist (`#registry`) and
 * how a call runs (`#dispatch`). Those were all one package called `core`,
 * which was a name for "the rest of it" rather than for anything.
 */

export {
  DEPLOY_DEFAULTS,
  SUPPORTED_CONTRACT,
  configSchema,
  SINGLE_INSTANCE_PROVIDERS,
  connectionsFileSchema,
  declaredTarget,
  grantSchema,
  isPointer,
  memberSchema,
  workspaceSchema,
  workspaceTargetSchema,
  type AuthorizationConfig,
  type Config,
  type ConnectionConfig,
  type ConnectionsFile,
  type DeployConfig,
  type GrantConfig,
  type IdentityEntry,
  type MemberConfig,
  type PolicyRuleConfig,
  type TargetConfig,
  type WorkspaceConfig,
  type WorkspaceTarget,
} from './schema.ts';

export {
  assertConnectionsUnique,
  assertGrantsResolve,
  assertNoRenamedProviders,
  connectionRefOf,
  defaultConnectionLabel,
  selectConnections,
  soleGrantFor,
  vaultRef,
  type SelectedConnection,
} from './connections.ts';

export { PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF } from './pairing.ts';

export {
  KNOWLEDGE_LAYOUT,
  KNOWLEDGE_PREFIX,
  knowledgeRoot,
  knowledgeTargetSchema,
  parseRepository,
  type KnowledgeArea,
  type KnowledgeConfig,
} from './knowledge.ts';

export {
  ConfigError,
  RENAMED_PROVIDERS,
  loadConfigFile,
  parseConfig,
  renamedProviderFor,
  validateConfig,
  validateConfigShape,
  type LoadedConfig,
  type ProviderRename,
} from './load.ts';

export {
  findSecrets,
  formatSecretFindings,
  shannonEntropy,
  type SecretFinding,
} from './secret-detection.ts';

export {
  WORKSPACE_FILE,
  installRoot,
  listProfiles,
  loadProfileConfig,
  loadWorkspaceProfiles,
  noProfileNamed,
  profilePath,
  readWorkspace,
  resolveSelection,
  resolveWorkspaceRoot,
  workspacePath,
  type LoadedProfile,
  type WorkspaceProfiles,
} from './workspace.ts';
export {
  LEGACY_TARGET_ENV,
  noTargetNamed,
  notInRegistry,
  requireTarget,
  type Registry,
} from './targets.ts';
export {
  isLegacyProfile,
  isLegacyWorkspace,
  legacyConfigSchema,
  legacyTargetSchema,
  type LegacyConfig,
  type LegacyTarget,
} from './legacy.ts';
export {
  declaredHere,
  openTarget,
  readRegistry,
  resolveTargetWorkspace,
  type ResolvedTarget,
} from './registry.ts';
export { recordTarget, removeTarget } from './deployments.ts';
export {
  anyIssuedToken,
  membersResolver,
  nextTokenId,
  readEndpointTokens,
  tokenRef,
  type EndpointToken,
} from './tokens.ts';
export {
  isRemoteWorkspace,
  readWorkspaceFile,
  workspaceFiles,
  writeWorkspaceFile,
} from './files.ts';
export {
  CONNECTIONS_FILE,
  readConnections,
  type ProfileSelection,
  type Resolution,
  type ResolveOptions,
} from './workspace.ts';

export {
  PROFILE_FILE,
  LEGACY_DATA_DIR,
  LEGACY_WORKSPACE_FILE,
  legacyProfileConfig,
  layout,
} from './layout.ts';
