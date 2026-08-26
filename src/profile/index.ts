/**
 * A profile: its file, its schema, and where it lives on disk.
 *
 * **One profile = one config = one database = one credential store.** Profiles
 * share an endpoint and its token (ADR-009); they never share state. This
 * component owns everything about what a profile *is* — the YAML contract, the
 * loader that validates it, and the workspace resolution that finds it.
 *
 * What it deliberately does not own: which providers exist (`#registry`) and
 * how a call runs (`#dispatch`). Those were all one package called `core`,
 * which was a name for "the rest of it" rather than for anything.
 */

export {
  SUPPORTED_CONTRACT,
  configSchema,
  workspaceSchema,
  type AuthorizationConfig,
  type Config,
  type ConnectionConfig,
  type DeployConfig,
  type IdentityEntry,
  type PolicyRuleConfig,
  type TargetConfig,
  type WorkspaceConfig,
} from './schema.ts';

export {
  KNOWLEDGE_LAYOUT,
  knowledgeRoot,
  knowledgeTargetSchema,
  parseRepository,
  type KnowledgeArea,
  type KnowledgeConfig,
} from './knowledge.ts';

export {
  ConfigError,
  loadConfigFile,
  parseConfig,
  validateConfig,
  type LoadedConfig,
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
  noProfileNamed,
  profilePath,
  readWorkspace,
  resolveSelection,
  resolveWorkspaceRoot,
  workspacePath,
} from './workspace.ts';
export {
  LEGACY_TARGET_ENV,
  noTargetNamed,
  requireTarget,
  undeclaredTarget,
} from './targets.ts';
export {
  isRemoteWorkspace,
  readWorkspaceFile,
  workspaceFiles,
  writeWorkspaceFile,
} from './files.ts';
export {
  type ProfileSelection,
  type Resolution,
  type ResolveOptions,
} from './workspace.ts';

export {
  DATA_DIR,
  layout,
  profileDir,
} from './layout.ts';
