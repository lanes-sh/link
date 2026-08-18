/**
 * The invocation path — the one sequence every call runs, with no way around
 * it:
 *
 *   policy → limits → provider → audit
 *
 * The ordering is not stylistic. Policy is evaluated *before* a provider is
 * reached, so a provider never sees a request it was not authorised to serve
 * and authorization is never something provider code could get wrong. Exactly
 * one audit event is written per invocation, by a `finally` rather than by
 * remembering to call it at each return.
 *
 * `context.ts` is what a provider is handed: scoped state, scoped blobs, an
 * allowlist of credential refs, and a logger. Never a raw backend.
 */

export {
  buildProviderContext,
  createConsoleLogger,
  createProviderLogger,
  createScopedStore,
  resolveSecretRefs,
  scopeNamespace,
  type BuildContextOptions,
} from './context.ts';

export {
  Dispatcher,
  type DispatchDeps,
  type DispatchOutcome,
  type DispatchRequest,
} from './dispatch.ts';
