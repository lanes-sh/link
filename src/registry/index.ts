/**
 * What exists, and what it is called.
 *
 * The registry holds every provider available to a profile — built in, or
 * declared as workspace YAML — and the capabilities each one contributes,
 * addressed `provider.capability`. `reconcile` is the other half of the same
 * question: the config file says what should exist, the database records what
 * did, and reconcile makes the second match the first without ever deleting
 * history.
 *
 * `policy-bridge` turns a profile's declared rules into the document
 * `#policy` evaluates, and lives here because it is a translation of config,
 * not a policy decision.
 */

export {
  ProviderRegistry,
  matchesGlob,
  type RegisteredCapability,
  type RegisteredProvider,
} from './registry.ts';

export {
  applyReconcile,
  credentialRefFor,
  formatPlan,
  planIsNoop,
  planReconcile,
  rotatableCredentialRefsFor,
  type AuthenticatingProviders,
  type ReconcileAction,
  type ReconcilePlan,
} from './reconcile.ts';

export { toPolicyDocument } from './policy-bridge.ts';
