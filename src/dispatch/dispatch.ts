import type { AuditDraft, AuditLogger, AuditSink, AuthorizationResult } from '#audit';
import { keepKeys, redactAllValues } from '#audit';
import type { Principal } from '#auth';
import type { SecretStore } from '#secrets';
import type { RuntimeState } from '#stores/state';
import type { PolicyDocument } from '#policy';
import { RateLimiter, evaluate } from '#policy';
import type { BlobStore } from '#stores/blobs';
import type {
  AnyConnector,
  AuthStrategyContext,
  CapabilityResult,
  ConnectorContext,
  Logger,
} from '#connectivity';
import { isToolResult, strategyContextFrom, strategyFor } from '#connectivity';
import type { Config } from '#profile';
import { buildProviderContext, createProviderLogger } from './context.ts';
import { fetchStaged, stageAttachment } from './staging.ts';
import type { FetchStagedRequest, StagedAttachment, StageRequest } from './staging.ts';
import type { ProviderRegistry } from '#registry';

/**
 * The dispatch path.
 *
 * Every invocation goes through here in one fixed order — authenticate,
 * resolve, authorize, rate-limit, dispatch, audit — with no way around it.
 * The ordering is not stylistic: policy is evaluated before a provider is
 * reached, so a provider never sees a request it was not authorised to serve,
 * and authorization is never something provider code could get wrong.
 *
 * Exactly one audit event is written per invocation, on every path including
 * denials. That is enforced structurally by `finally` rather than by
 * remembering to call it at each return.
 */

export interface DispatchDeps {
  readonly config: Config;
  readonly registry: ProviderRegistry;
  /**
   * Resolve the connector for a provider. Supplied by the caller so core does
   * not import connector implementations, keeping the dependency direction
   * intact: infrastructure -> sdk -> core -> connectors.
   */
  readonly connectorFor: (providerId: string, connectionId: string) => AnyConnector | undefined;
  /** Attach whatever the manifest's auth kind requires to an outbound request. */
  readonly authorizeRequest?: (
    providerId: string,
    connectionId: string,
    request: Request,
  ) => Promise<Request>;
  readonly policy: PolicyDocument;
  /** Optional instance floor. Empty in M1; composition is tighten-only. */
  readonly floor?: PolicyDocument;
  readonly state: RuntimeState;
  /**
   * Where events go. Separate from `state` because the log is no longer in
   * it — and because dispatch only ever writes, so taking the sink rather than
   * the whole store means this path structurally cannot read the log back.
   */
  readonly audit: AuditSink;
  readonly credentials: SecretStore;
  readonly storage: BlobStore;
  readonly limiter: RateLimiter;
  readonly log: Logger;
  readonly now?: () => number;
}

export interface DispatchRequest {
  readonly principal: Principal;
  /** Fully qualified, e.g. `example.echo`. */
  readonly capabilityId: string;
  /** Fully qualified, e.g. `example.a`. */
  readonly connectionKey: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Self-reported by the client. Observability only — never authorization. */
  readonly clientLabel?: string | undefined;
  readonly signal?: AbortSignal;
}

/**
 * `result` is a union because a capability is not necessarily a tool — a
 * resource read, a resource listing, and a prompt render come back through this
 * same path, deliberately, so that all four are policy-checked and audited
 * identically. Narrow it with the `is*Result` guards from the provider SDK.
 */
export type DispatchOutcome =
  | { readonly ok: true; readonly result: CapabilityResult }
  | { readonly ok: false; readonly authorization: AuthorizationResult; readonly message: string };

export class Dispatcher {
  readonly #deps: DispatchDeps;
  readonly #now: () => number;

  constructor(deps: DispatchDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Take bytes for a later call to name, and record that it happened.
   *
   * The body is in `staging.ts`; what belongs here is that it goes through the
   * dispatcher at all. Staging is a write against one account — it puts the
   * operator's file inside the endpoint, where a later send can post it outward
   * — so it is audited on the same path as the send rather than beside it.
   */
  /** What both halves of staging take. One place, so the two cannot diverge. */
  get #staging() {
    return {
      storage: this.#deps.storage,
      audit: this.#deps.audit,
      profile: this.#deps.config.instance.profile,
    };
  }

  async stageAttachment(request: StageRequest): Promise<StagedAttachment> {
    return stageAttachment({ ...this.#staging, now: this.#now }, request);
  }

  /** The same door, outward — bytes back to the client. See `fetchStaged`. */
  async fetchStagedAttachment(request: FetchStagedRequest) {
    return fetchStaged(this.#staging, request);
  }

  /**
   * Record an attempt that was refused before dispatch.
   *
   * Policy-filtered discovery means a capability the caller may not use is
   * never advertised, so a call naming it is rejected by the protocol layer
   * and never reaches `invoke`. Nothing was invoked — but an agent probing for
   * tools it does not have is precisely the behaviour the log exists to
   * capture, and without this it would leave no trace at all.
   */
  async recordRefusal(request: {
    readonly principal: Principal;
    readonly capabilityId: string;
    readonly connectionKey?: string | undefined;
    readonly clientLabel?: string | undefined;
  }): Promise<void> {
    const [providerId = ''] = splitKey(request.capabilityId);

    await this.#deps.audit.append({
      profile: this.#deps.config.instance.profile,
      principal: request.principal.id,
      ...(request.clientLabel ? { clientLabel: request.clientLabel } : {}),
      provider: providerId,
      ...(request.connectionKey ? { connection: request.connectionKey } : {}),
      capability: request.capabilityId,
      arguments: {},
      authorization: 'denied_default',
      status: 'not_invoked',
      durationMs: 0,
      error: {
        kind: 'not_available',
        message: 'capability is not advertised to this principal',
      },
    });
  }

  async invoke(request: DispatchRequest): Promise<DispatchOutcome> {
    const started = this.#now();
    const { config, registry, state, audit } = this.#deps;
    const [providerId = ''] = splitKey(request.capabilityId);

    const annotations: Record<string, unknown> = {};
    let authorization: AuthorizationResult = 'denied_default';
    let status: AuditDraft['status'] = 'not_invoked';
    let auditArguments: Record<string, unknown> = redactAllValues(request.arguments);
    let error: { kind: string; message: string } | undefined;
    let outcome: DispatchOutcome = {
      ok: false,
      authorization: 'denied_default',
      message: 'not evaluated',
    };

    try {
      const registered = registry.findCapability(request.capabilityId);
      if (!registered) {
        error = { kind: 'unknown_capability', message: `No such capability: ${request.capabilityId}` };
        // An unknown capability is reported as a plain denial rather than
        // "no such tool", so probing cannot distinguish a capability that does
        // not exist from one this profile may not use.
        return (outcome = deny('denied_default', `Capability ${request.capabilityId} is not available`));
      }

      const entry = registry.get(providerId)!;

      // Apply redaction now that we know which capability this is, so a denial
      // is logged with the same redaction an allowed call would get.
      //
      // Local capabilities carry their own rule. Discovered ones cannot: we did
      // not author them and cannot know what is sensitive, so the default
      // withholds every value and a manifest opts specific keys back in.
      const declaredKeys = entry.manifest.redact?.[registered.capability?.name ?? registered.discovered?.name ?? ''];
      const redact =
        registered.capability?.redact ?? (declaredKeys ? keepKeys(...declaredKeys) : undefined);

      auditArguments = (redact ?? redactAllValues)(request.arguments);

      const declared = config.connections.find(
        (connection) => `${connection.provider}.${connection.id}` === request.connectionKey,
      );
      if (!declared || declared.provider !== providerId) {
        return (outcome = deny(
          'denied_default',
          `Connection ${request.connectionKey} is not available`,
        ));
      }

      const decision = evaluate(
        {
          principal: request.principal.id,
          capability: request.capabilityId,
          connection: request.connectionKey,
        },
        this.#deps.policy,
        this.#deps.floor,
      );

      authorization = decision.reason;
      if (!decision.allowed) {
        return (outcome = deny(
          decision.reason,
          `Not permitted: ${request.capabilityId} on ${request.connectionKey}`,
        ));
      }

      // Two buckets: one for the endpoint as a whole, one per connection to
      // protect a vendor's quota from an agent stuck in a retry loop.
      const perProfile = this.#deps.limiter.take(
        `profile:${config.instance.profile}`,
        config.limits.requests_per_minute,
      );
      const perConnection = perProfile.allowed
        ? this.#deps.limiter.take(
            `connection:${request.connectionKey}`,
            config.limits.upstream_calls_per_minute,
          )
        : perProfile;

      if (!perProfile.allowed || !perConnection.allowed) {
        const retryAfterMs = Math.max(perProfile.retryAfterMs, perConnection.retryAfterMs);
        authorization = 'denied_rate_limited';
        return (outcome = deny(
          'denied_rate_limited',
          `Rate limit exceeded. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`,
        ));
      }

      const record = await state.connections.get(declared.provider, declared.id);
      if (record && record.status !== 'active') {
        authorization = 'denied_connection_unauthorized';
        return (outcome = deny(
          'denied_connection_unauthorized',
          record.status === 'unauthorized'
            ? `Connection ${request.connectionKey} has no valid credential. Connecting it again for this profile and target would store one.`
            : `Connection ${request.connectionKey} is disabled.`,
        ));
      }

      const auditLogger: AuditLogger = {
        annotate(detail) {
          Object.assign(annotations, detail);
        },
      };

      // A provider whose authentication is code rather than a manifest field.
      // The strategy stands in for the credential resolver completely: it holds
      // whatever session the vendor issues, signs the outbound request, and
      // checks the reply. Looked up once, because both halves of the connector
      // context come from the same one.
      const strategy =
        entry.manifest.auth.kind === 'strategy'
          ? strategyFor(entry.manifest, this.#deps.registry)
          : undefined;

      // Derived from the provider context — which is handed the closure below,
      // so it cannot exist yet. Both are only ever *called* after this block
      // finishes, and memoising keeps one context per invocation rather than
      // one per outbound request.
      let strategyContext: AuthStrategyContext | undefined;
      const forStrategy = (): AuthStrategyContext =>
        (strategyContext ??= strategyContextFrom({
          source: providerContext,
          manifest: entry.manifest,
          connectionId: declared.id,
          profile: this.#deps.config.instance.profile,
        }));

      // One closure, handed to both contexts. A provider that authors a
      // capability its transport cannot express still calls the vendor through
      // the same authorizer the transport would have used.
      const authorize = (outbound: Request): Promise<Request> =>
        strategy
          ? strategy.authorize(outbound, forStrategy())
          : this.#deps.authorizeRequest
            ? this.#deps.authorizeRequest(providerId, declared.id, outbound)
            : Promise.resolve(outbound);

      const providerContext = buildProviderContext({
        manifest: entry.manifest,
        definition: entry.definition,
        connection: declared,
        state,
        credentials: this.#deps.credentials,
        storage: this.#deps.storage,
        audit: auditLogger,
        log: createProviderLogger(this.#deps.log, providerId, declared.id),
        signal: request.signal ?? new AbortController().signal,
        // Which vendors this profile registered a client of its own for. A
        // provider that could be brokered but is not reads its client from the
        // store, so it has to be able to.
        ownClients: Object.keys(this.#deps.config.oauth_apps),
        ...(entry.manifest.connector.kind === 'local' ? {} : { authorize }),
      });

      const connector = this.#deps.connectorFor(providerId, declared.id);
      if (!connector) {
        status = 'error';
        error = { kind: 'no_connector', message: `No connector for provider ${providerId}` };
        return (outcome = {
          ok: false,
          authorization: 'allowed',
          message: `Provider ${providerId} has no usable connector.`,
        });
      }

      // Only where the strategy asks for it. A vendor that signs its replies
      // expects them verified, and the transport clones the response so the
      // check costs the caller nothing.
      const verifyResponse = strategy?.verify?.bind(strategy);

      const connectorContext: ConnectorContext = {
        manifest: entry.manifest,
        provider: providerContext,
        authorize,
        ...(verifyResponse
          ? { verify: (response: Response) => verifyResponse(response, forStrategy()) }
          : {}),
      };

      // The connector owns argument validation: a local provider validates
      // against its Zod schema, a proxied one against the upstream JSON Schema
      // the MCP layer already enforced at registration.
      const target = registered.discovered ?? {
        name: registered.capability!.name,
        description: registered.capability!.description,
        inputSchema: {},
      };

      const result = await connector.invoke(target, request.arguments, connectorContext);
      // Only a tool can report a soft failure. A resource or a prompt that
      // cannot produce its answer throws, and lands in the catch below.
      status = isToolResult(result) && result.isError ? 'error' : 'ok';
      return (outcome = { ok: true, result });
    } catch (caught) {
      status = 'error';
      error = { kind: 'provider_error', message: (caught as Error).message };
      return (outcome = {
        ok: false,
        authorization,
        message: `${request.capabilityId} failed: ${(caught as Error).message}`,
      });
    } finally {
      // One event per invocation, on every path. An audit log that records
      // only successes cannot answer "what did this agent try to do", which is
      // the question worth asking.
      await audit.append({
        profile: config.instance.profile,
        principal: request.principal.id,
        ...(request.clientLabel ? { clientLabel: request.clientLabel } : {}),
        provider: providerId,
        connection: request.connectionKey,
        capability: request.capabilityId,
        arguments:
          Object.keys(annotations).length > 0
            ? { ...auditArguments, _annotations: annotations }
            : auditArguments,
        authorization: outcome.ok ? 'allowed' : authorization,
        status,
        durationMs: this.#now() - started,
        ...(error ? { error } : {}),
      });
    }
  }
}

function deny(authorization: AuthorizationResult, message: string): DispatchOutcome {
  return { ok: false, authorization, message };
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf('.');
  return index === -1 ? [key, ''] : [key.slice(0, index), key.slice(index + 1)];
}
