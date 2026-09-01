import type { Principal } from '#auth';
import type { AuditSink } from '#audit';
import type { PolicyDocument, ProfilePolicy, RateLimiter } from '#policy';
import type { Config, ConnectionConfig } from '#profile';
import type { ProviderRegistry } from '#registry';
import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import type { RuntimeState } from '#stores/state';
import type { AnyConnector } from '#connectivity';
import type { Logger } from '#connectivity';

/**
 * What the dispatcher is given, and what it is asked.
 *
 * Split from the dispatcher itself so that file stays inside the size budget.
 * The seam is real rather than arithmetic: everything here is what a *caller*
 * assembles, and the class next door is the fixed order in which a call is
 * authorised and run. Reading one has never required reading the other.
 */

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
  /**
   * The accounts this workspace holds, and the clients it registered (ADR-057).
   *
   * Separate from `config` because neither is the profile's to declare. The
   * *gate* stays policy: a connection that exists and is not granted resolves
   * and is then denied `denied_default`, which is the same answer a caller gets
   * for one that does not exist — two shapes of "no" that read alike, so probing
   * is not an oracle for what the workspace holds.
   */
  readonly connections: readonly ConnectionConfig[];
  readonly oauthApps: readonly string[];
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
  readonly policy: ProfilePolicy;
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
