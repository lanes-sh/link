import type { ConnectorConfig, ProviderManifest } from './manifest/index.ts';
import type { CapabilityResult, ProviderContext, ToolResult } from './index.ts';

/**
 * A connector turns a connectivity type into capabilities.
 *
 * Adding a *provider* means adding a manifest, never a connector. Adding a
 * *kind* means meeting a protocol we cannot otherwise reach, which is rare and
 * belongs in review — the test is whether the code is about a protocol or about
 * a vendor. `http.ts` is 215 lines serving Gmail, Drive, and every REST API
 * ever; `imap.ts` serves iCloud, Fastmail, and any Dovecot. Neither mentions a
 * vendor. The moment a kind would, it is the wrong shape and the answer is a
 * manifest, or at most an `AuthStrategy`.
 *
 * `imap` and `dav` were added because iCloud has no MCP server, no OAuth, and
 * no REST API, and because no manifest can describe IMAP — there is no
 * machine-readable description of it to point at. See ADR-010.
 */

/** The connectivity kinds, derived from the schema so it stays the only list. */
export type ConnectorKind = ConnectorConfig['kind'];

/**
 * A capability as a connector reports it.
 *
 * `inputSchema` is **JSON Schema**, not Zod: it comes from an upstream MCP
 * server or an OpenAPI document, neither of which we author. The MCP layer
 * converts it at registration with the SDK's `fromJsonSchema`. Local providers
 * still author Zod and are converted the other way.
 */
export interface DiscoveredCapability {
  /** Unqualified — `search`. Core qualifies it as `<provider>.<name>`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Which bundle this belongs to, decided by the connector. */
  readonly bundle?: string;
  /**
   * Opaque routing detail the connector needs to invoke this again — an
   * upstream tool name, or an OpenAPI method and path. Cached alongside the
   * capability so a cold instance can serve without re-discovering.
   */
  readonly target?: Record<string, unknown>;
}

/**
 * What discovery is allowed to see: the manifest, and nothing else.
 *
 * Deliberately narrower than `ConnectorContext`. Discovery runs at `connect`
 * time, *before* the connection exists in config — so there is no
 * `ProviderContext` to hand over, and the three call sites used to fake one with
 * `provider: undefined as never`. Narrowing the parameter says the true thing
 * instead: what a provider exposes is a property of the provider, not of any one
 * account. A connector needing a credential here takes it as a constructor
 * option, the way `createMcpConnector` already takes `accessToken`.
 */
export interface DiscoveryContext {
  readonly manifest: ProviderManifest;
}

export interface ConnectorContext extends DiscoveryContext {
  /** Everything a provider is allowed to reach, unchanged from M1. */
  readonly provider: ProviderContext;
  /**
   * Prepare an outbound request: attach whatever the manifest's auth kind
   * requires. Supplied by core so a connector never handles raw credentials.
   */
  authorize(request: Request): Promise<Request>;
  /** Verify a response, where the auth strategy demands it (bunq signs replies). */
  verify?(response: Response): Promise<void>;
}

/**
 * A connector, parameterised by what its capabilities can produce.
 *
 * The default is `ToolResult`, because a remote kind serves tools and nothing
 * else: an upstream MCP server's `tools/list` and an OpenAPI document both
 * describe operations, so there is no resource or prompt for `mcp`, `http`,
 * `imap`, or `dav` to return. `local` is the exception and declares
 * `Connector<CapabilityResult>`.
 *
 * Parameterised rather than simply widened so those four keep their precise
 * return type — a caller of `createImapConnector` still gets a `ToolResult`
 * back and does not have to narrow a union that can only ever hold one member.
 * Core dispatches through `AnyConnector`, which every kind satisfies because a
 * method's return type is covariant.
 */
export interface Connector<Result extends CapabilityResult = ToolResult> {
  readonly kind: ConnectorKind;

  /**
   * Enumerate what this connection exposes.
   *
   * Called at `connect` time and on refresh, never on the dispatch path — the
   * server is stateless and reads capabilities from the database cache, so a
   * cold instance serves without a discovery round trip.
   */
  discover(context: DiscoveryContext): Promise<DiscoveredCapability[]>;

  /** Invoke one capability. Policy has already allowed it; this only performs it. */
  invoke(
    capability: DiscoveredCapability,
    args: Readonly<Record<string, unknown>>,
    context: ConnectorContext,
  ): Promise<Result>;

  /**
   * Whose account this connection turned out to be.
   *
   * For a protocol that authenticates by username there is nothing to probe:
   * the answer is the name the *server accepted*, which is stronger than the one
   * the operator typed. Nullary because the connector was built for exactly one
   * connection and has no business naming another.
   */
  identify?(): Promise<string | null>;

  /**
   * Release a long-lived session, if this kind holds one.
   *
   * `mcp` and `http` are request-shaped and implement nothing here. `imap` holds
   * a socket, because Apple throttles reconnection far harder than it throttles
   * an open session.
   */
  close?(): Promise<void>;
}

/**
 * Any connector at all — what core holds, since it dispatches to all of them.
 *
 * Every `Connector<ToolResult>` is one of these, so the four remote kinds need
 * no annotation to fit.
 */
export type AnyConnector = Connector<CapabilityResult>;

/**
 * Pluggable auth, for what no declarative form should express.
 *
 * The only place per-vendor code is permitted outside `local` providers. Keep
 * it to auth: the moment a strategy starts translating endpoints, the 612-line
 * problem this milestone removed has come back.
 */
export interface AuthStrategy {
  readonly id: string;

  /**
   * One-time setup at connect time — key generation, a handshake, whatever the
   * vendor demands. Anything durable goes into the credential store.
   */
  setup?(context: AuthStrategyContext): Promise<void>;

  /** Per-request: sign it, add headers, refresh a session if one has expired. */
  authorize(request: Request, context: AuthStrategyContext): Promise<Request>;

  /** Optional response check — bunq signs its replies and expects them verified. */
  verify?(response: Response, context: AuthStrategyContext): Promise<void>;
}

export interface AuthStrategyContext {
  readonly manifest: ProviderManifest;
  readonly connectionId: string;
  /**
   * Which profile this is acting for.
   *
   * Nothing about authenticating one request needs it. What needs it is any
   * strategy that keeps something in process memory: one endpoint serves every
   * profile in the workspace from one process, so `<provider>.<connection>` is
   * not a unique key — two profiles each holding a bunq connection called
   * `main` would share whatever it named. `state` and `credentials` are already
   * scoped per profile and a cache in front of them must be too.
   */
  readonly profile: string;
  /** Read-only, scoped to this connection — the same boundary providers get. */
  readonly credentials: ProviderContext['credentials'];
  /**
   * Writable credential access, available **only during `setup`**.
   *
   * A handshake has to persist what it produces (a keypair, a session token),
   * which per-request code must never be able to do. Absent outside setup, so
   * the restriction is structural rather than a rule to remember.
   */
  readonly write?: (ref: string, value: string) => Promise<void>;
  readonly state: ProviderContext['state'];
  readonly log: ProviderContext['log'];
  readonly options: Readonly<Record<string, unknown>>;
}
