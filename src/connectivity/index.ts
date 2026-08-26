/**
 * Connectivity — what a provider declares, and the code behind each
 * declaration.
 *
 * Two axes, deliberately independent, one folder per option on each:
 *
 *   transports/   how we reach a service   (the manifest's `connector.kind`)
 *   auth/         how we prove who we are  (the manifest's `auth.kind`)
 *
 * A provider picks one from each column and adds nothing else. That is why
 * iCloud can speak IMAP with an app password while Gmail speaks HTTP with
 * OAuth, and why neither costs the other any code.
 *
 * This barrel is also the **provider authoring surface**: a provider must be
 * writable without reading the rest of the codebase. If you need something not
 * exported here, that is a bug in this file rather than a reason to reach into
 * another component. See `docs/detailed/creating-a-provider.md`.
 */

export type { ScopedStore, Logger, ConnectionInfo, ProviderContext } from './context.ts';

export type {
  Capability,
  CapabilityBase,
  CapabilityResult,
  ToolCapability,
  ToolResult,
  ResourceCapability,
  ResourceContents,
  ResourceResult,
  ResourceListResult,
  PromptCapability,
  PromptMessage,
  PromptResult,
} from './capability.ts';
export {
  isTool,
  isResource,
  isPrompt,
  isToolResult,
  isResourceResult,
  isResourceListResult,
  isPromptResult,
} from './capability.ts';

/**
 * Local providers — our own code, for `example` and the M3 owner layer.
 * Everything else is a manifest.
 */
export type { AuthRequirement, ProviderDefinition } from './provider.ts';
export { defineLocalProvider, defineProviderWithCapabilities } from './provider.ts';

export type {
  ProviderManifest,
  ConnectorConfig,
  AuthAssertion,
  AuthBroker,
  AuthConfig,
  SetupDeclaration,
  SetupPrompt,
  IdentityDeclaration,
  ScopeBundle,
  SetupRequirement,
  SetupNeeds,
} from './manifest/index.ts';
export {
  defineProvider,
  providerManifestSchema,
  setupSchema,
  bundleSchema,
  credentialRefForConnection,
  rotatableCredentialRefs,
  hasOwnClientPath,
  setupRequirements,
  UNNAMED_ID,
  RESERVED_PROVIDER_IDS,
  READ_BUNDLE,
  WRITE_BUNDLE,
} from './manifest/index.ts';

export type {
  AnyConnector,
  Connector,
  ConnectorContext,
  ConnectorKind,
  DiscoveryContext,
  DiscoveredCapability,
  AuthStrategy,
  AuthStrategyContext,
} from './connector.ts';

// Re-exported so a provider author imports from one place.
export type { RedactionRule } from '#audit';
export { keepKeys, redaction, redactAllValues } from '#audit';
export type { SecretRef, ScopedSecrets } from '#secrets';
export type { BlobStore, BlobKey, BlobMetadata } from '#stores/blobs';
