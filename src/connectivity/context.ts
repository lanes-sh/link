import type { AuditLogger } from '#audit';
import type { ScopedSecrets } from '#secrets';
import type { BlobStore } from '#stores/blobs';

/**
 * Key/value state for one provider on one connection.
 *
 * Already namespaced by core before a provider receives it, so there is no key
 * a provider can construct that reaches another provider's state or another
 * connection's state within its own provider.
 */
export interface ScopedStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;

  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
}

export interface Logger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

/** The connection a capability was invoked for. */
export interface ConnectionInfo {
  /** Connection id, unique within the provider. e.g. `main`. */
  readonly id: string;
  /** Fully qualified: `gmail.main`. */
  readonly key: string;
  readonly displayName: string;
  /** Validated against the provider's own `connectionSchema`. */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Everything a provider is given, and nothing else.
 *
 * Providers receive scoped capabilities, never raw backends. There is no
 * `RuntimeState` here, no `SecretStore`, no config, no policy engine, and no
 * way to reach another connection.
 *
 * Note what this does NOT protect against: provider code is trusted code. It
 * runs in-process and holds its connection's credential, so a malicious
 * provider can do anything that credential permits. There is no provider
 * sandbox in M1. Installing a third-party provider is equivalent to running
 * arbitrary code with access to that account, and
 * `https://lanes.sh/docs/link/creating-a-provider` says so plainly.
 */
export interface ProviderContext {
  readonly connection: ConnectionInfo;
  /**
   * Every profile this caller may reach, this one included.
   *
   * The narrowest widening of this interface that could carry it, and worth
   * saying why it belongs at all given the rule above. It is not a backend, a
   * credential or a store: it is the same routing fact the client already holds
   * in the `profile` enum on every tool it was shown, which `visibility.ts`
   * filters by `mayReach`. A provider cannot *act* in any of these — dispatch
   * still resolves one profile per call — so this grants no reach.
   *
   * It exists because a surface that describes what a caller can get to has to
   * be given the caller's answer rather than the workspace's.
   * `lanes_setup.overview` was handed every profile on disk and named them all,
   * which told a delegated member about profiles `mayReach` deliberately hides
   * from their enum (ADR-068).
   */
  readonly profiles: readonly string[];
  readonly state: ScopedStore;
  readonly storage: BlobStore;
  readonly credentials: ScopedSecrets;
  readonly audit: AuditLogger;
  readonly log: Logger;
  /** Aborted when the client disconnects or a limit is hit. */
  readonly signal: AbortSignal;
  /**
   * Attach this connection's credential to an outbound request.
   *
   * The same authorizer a connector is given, offered here for a provider that
   * has to call its own vendor's API directly — a capability authored precisely
   * because the generic transport cannot express the call. It is a
   * connection-scoped capability rather than a raw backend, which is the line
   * this interface draws: a provider still cannot read the credential, name a
   * different connection, or reach a store it did not declare.
   *
   * Optional because `local` providers hold no third-party account and the test
   * harness builds a context without one.
   */
  authorize?(request: Request): Promise<Request>;
}
