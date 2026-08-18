/**
 * The provider declaration format, one file per section.
 *
 * It was one 513-line file, which hid the shape of the thing it describes: a
 * manifest is a *connectivity type* plus an *auth method* plus the operator-
 * facing text around them, and those are the two axes the whole design rests
 * on. `connector.ts` and `auth.ts` are now the same size and sit side by side,
 * which is what the sentence "auth is orthogonal to connectivity" looks like
 * when the files agree with it.
 */

export {
  connectorSchema,
  davConnectorSchema,
  fsConnectorSchema,
  httpConnectorSchema,
  imapConnectorSchema,
  localConnectorSchema,
  mcpConnectorSchema,
  type ConnectorConfig,
} from './connector.ts';

export {
  authNoneSchema,
  authOAuthSchema,
  authSchema,
  authStrategySchema,
  authTokenSchema,
  type AuthConfig,
} from './auth.ts';

export { setupPromptSchema, setupSchema, type SetupDeclaration, type SetupPrompt } from './setup.ts';
export { READ_BUNDLE, WRITE_BUNDLE, bundleSchema, type ScopeBundle } from './bundles.ts';
export { identitySchema, type IdentityDeclaration } from './identity.ts';
export { credentialRefForConnection, rotatableCredentialRefs } from './credential-ref.ts';
export {
  RESERVED_PROVIDER_IDS,
  defineProvider,
  providerManifestSchema,
  type ProviderManifest,
} from './provider.ts';

export type { SetupRequirement, SetupNeeds } from './requirements.ts';
export { setupRequirements, UNNAMED_ID } from './requirements.ts';
