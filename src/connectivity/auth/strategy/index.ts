import type { AuthStrategy, AuthStrategyContext } from '../../connector.ts';
import type { ProviderContext } from '../../context.ts';
import type { ProviderDefinition } from '../../provider.ts';
import type { ProviderManifest } from '../../manifest/index.ts';

/**
 * The escape hatch: auth no declarative form should try to express.
 *
 * A strategy is the one place per-vendor code is permitted outside `local`
 * providers, and it stays *auth* — a request in, an authorised request out.
 * The moment one starts translating endpoints, the problem ADR-008 removed has
 * come back.
 *
 * There is no global registry here, and that is deliberate. A strategy is not a
 * plugin the runtime discovers; it is a property of the provider that needs it,
 * so it travels on that provider's `ProviderDefinition` the same way an authored
 * capability does. Two things follow, both of them the point:
 *
 *   - this component stays free of vendor names, which is the rule
 *     `architecture.test.ts` holds over everything a request passes through
 *   - adding one is still a folder under `providers/` and a line in its index,
 *     rather than a folder here plus a registration somewhere else
 */

/**
 * What `strategyFor` needs from the registry, and no more.
 *
 * Structural rather than the real `ProviderRegistry`, so this file states its
 * dependency as two methods instead of importing a component to name a type.
 */
export interface StrategySource {
  get(id: string): { readonly definition?: ProviderDefinition | undefined } | undefined;
  list(): readonly { readonly definition?: ProviderDefinition | undefined }[];
}

/**
 * The strategy a manifest declares.
 *
 * Its own definition first, which is the built-in case: `providers/bunq`
 * carries the code for the manifest beside it, and the two must agree about
 * which strategy that is. A manifest naming `strategy: acme` while its
 * definition carries something else is a wiring mistake that would otherwise
 * surface as a signature the vendor rejects — a long way from its cause.
 *
 * Then any other registered provider that supplies one by that name, which is
 * the case a declaration-only manifest needs. A workspace YAML in
 * `providers.d/` is parsed into a `ProviderManifest` and has no definition at
 * all, so without this it could name a strategy and never reach it — and naming
 * one is exactly what a manifest is for. It is also the only way to point a
 * connection at a vendor's sandbox, since a built-in manifest's `options` are
 * not the operator's to edit.
 *
 * Borrowing the *code* is not borrowing the *credential*: the ref still derives
 * from the manifest's own id, so `bunq_sandbox` reads `bunq_sandbox/<id>` and
 * cannot reach what `bunq` holds.
 */
export function strategyFor(
  manifest: ProviderManifest,
  source: StrategySource,
): AuthStrategy {
  if (manifest.auth.kind !== 'strategy') {
    throw new Error(`Provider "${manifest.id}" does not declare a strategy.`);
  }

  const named = manifest.auth.strategy;
  const own = source.get(manifest.id)?.definition?.authStrategy;

  if (own) {
    if (own.id !== named) {
      throw new Error(
        `Provider "${manifest.id}" declares auth strategy "${named}" but carries "${own.id}".`,
      );
    }
    return own;
  }

  const borrowed = source
    .list()
    .map((entry) => entry.definition?.authStrategy)
    .find((strategy) => strategy?.id === named);

  if (!borrowed) refuseStrategy(named);
  return borrowed;
}

/**
 * What a strategy is given, derived from what the provider is given.
 *
 * Narrower than a `ProviderContext` on purpose: the connection's own
 * credentials read-only, its own scoped state, and its logger. Nothing else,
 * and in particular no storage, no audit logger, and no signal — a strategy
 * authenticates a request and has no business doing anything a provider does.
 *
 * `write` is the one part that varies, and the variation *is* the rule.
 * Persisting a credential is a setup-time act, so `connect` passes a writer and
 * the dispatch path does not. Per-request code then cannot store a credential
 * because there is nothing on the object to store one with, rather than because
 * somebody remembered not to.
 *
 * Takes the three fields it reads rather than a whole `ProviderContext`, so the
 * two callers can be what they are: dispatch hands over the context it already
 * built, and `connect` — which has no provider context, because the connection
 * does not exist yet — assembles the same three from the runtime.
 */
export function strategyContextFrom(
  source: Pick<ProviderContext, 'credentials' | 'state' | 'log'>,
  manifest: ProviderManifest,
  connectionId: string,
  write?: (ref: string, value: string) => Promise<void>,
): AuthStrategyContext {
  return {
    manifest,
    connectionId,
    credentials: source.credentials,
    state: source.state,
    log: source.log,
    options: manifest.auth.kind === 'strategy' ? (manifest.auth.options ?? {}) : {},
    ...(write ? { write } : {}),
  };
}

/**
 * A manifest asked for a strategy nothing supplies.
 *
 * Fails loudly rather than sending an unauthenticated request, which would fail
 * upstream with an error about the vendor rather than about the wiring.
 */
export function refuseStrategy(strategy: string): never {
  throw new Error(
    `Auth strategy "${strategy}" is not registered. ` +
      `Strategies are the only place per-vendor code belongs; see docs/detailed/creating-a-provider.md.`,
  );
}
