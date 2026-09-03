import type { AuditLogger } from '#audit';
import type { SecretRef, SecretStore } from '#secrets';
import { scopeSecrets } from '#secrets';
import type { RuntimeState } from '#stores/state';
import type { BlobStore } from '#stores/blobs';
import { scopeBlobStore } from '#stores/blobs';
import type {
  ConnectionInfo,
  Logger,
  ProviderContext,
  ProviderDefinition,
  ProviderManifest,
  ScopedStore,
} from '#connectivity';
import { credentialRefForConnection } from '#connectivity';
import type { ConnectionConfig } from '#profile';

/**
 * Assembling what a provider is handed.
 *
 * Providers receive scoped capabilities, never raw backends. Every boundary
 * here is enforced by construction rather than by asking providers to behave:
 * the state namespace is applied before the provider sees the store, the blob
 * namespace likewise, and credentials are restricted to an explicit allowlist
 * computed from what the connection declares.
 */

/** `<provider>/<connection>` — the namespace both state and blobs are scoped to. */
export function scopeNamespace(provider: string, connectionId: string): string {
  return `${provider}/${connectionId}`;
}

export function createScopedStore(state: RuntimeState, namespace: string): ScopedStore {
  return {
    get: (key) => state.kv.get(namespace, key),
    set: (key, value) => state.kv.set(namespace, key, value),
    delete: (key) => state.kv.delete(namespace, key),
    keys: () => state.kv.keys(namespace),

    async getJson<T>(key: string): Promise<T | null> {
      const raw = await state.kv.get(namespace, key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Stored state that will not parse is a provider bug, not a reason to
        // fail the request; treat it as absent and let the provider rewrite it.
        return null;
      }
    },

    setJson: (key, value) => state.kv.set(namespace, key, JSON.stringify(value)),
  };
}

/**
 * Which credential refs this connection may read.
 *
 * A provider declares them via `credentialRefs`; if it declares nothing, the
 * connection's own `credential_ref` is the entire allowlist. Either way the set
 * is computed here rather than asked for at read time, so a provider cannot
 * widen it by asking for more.
 */
export function resolveSecretRefs(
  manifest: ProviderManifest,
  connection: ConnectionConfig,
  definition?: ProviderDefinition,
  /**
   * Which `app` entries this profile declares a client of its own for.
   *
   * Only consulted for a provider that could also authorise against a broker.
   * Defaults to none, which is correct for every provider that declares no
   * broker: the gate below leaves those exactly as they were.
   */
  ownClients: readonly string[] = [],
): SecretRef[] {
  const refs = new Set<SecretRef>(
    definition?.credentialRefs?.(connection.id, connection.config ?? {}) ?? [],
  );

  if (connection.credential_ref) refs.add(connection.credential_ref);

  const auth = manifest.auth;

  if (auth.kind === 'oauth') {
    // The tokens for this connection, and — for a manual registration — the
    // shared app credentials every connection of that vendor authorises
    // against. Nothing wider: `gmail.main` must not reach `gmail/side`.
    refs.add(`${manifest.id}/${connection.id}`);
    if (auth.registration === 'manual' && auth.app) {
      // Only where this profile holds a client of its own. When the client is
      // the broker's there is no id, secret, or registration anywhere in this
      // store, so naming the three refs would grant reach to nothing while
      // describing an arrangement that does not exist — and a grant list is
      // read by people deciding what a provider can see.
      if (!auth.broker || ownClients.includes(auth.app)) {
        refs.add(`${auth.app}/client_id`);
        refs.add(`${auth.app}/client_secret`);
        refs.add(`${auth.app}/client`);
      }
    } else {
      refs.add(`${manifest.id}/client`);
    }
  }

  if (auth.kind !== 'none' && auth.kind !== 'oauth') {
    // The connection's own credential, wherever the manifest puts it — which
    // may be a ref shared with sibling providers of the same vendor
    // (`icloud/ada` serves mail, calendar, and contacts). Shared across
    // *providers* is not shared across *accounts*: this adds exactly one ref, so
    // `icloud_mail.will` still cannot reach `icloud/sam`.
    const ref = credentialRefForConnection(manifest, connection.id);
    if (ref) refs.add(ref);
  }

  return [...refs];
}

export interface BuildContextOptions {
  readonly manifest: ProviderManifest;
  /** Present only for `local` providers. */
  readonly definition?: ProviderDefinition | undefined;
  readonly connection: ConnectionConfig;
  readonly state: RuntimeState;
  readonly credentials: SecretStore;
  readonly storage: BlobStore;
  readonly audit: AuditLogger;
  readonly log: Logger;
  readonly signal: AbortSignal;
  /** The same closure the connector context gets. Absent for `local` providers. */
  readonly authorize?: ((request: Request) => Promise<Request>) | undefined;
  /** `oauth_apps` entries this profile declares. See `resolveSecretRefs`. */
  readonly ownClients?: readonly string[] | undefined;
  /** Every profile the caller may reach. See `ProviderContext.profiles`. */
  readonly profiles: readonly string[];
}

export function buildProviderContext(options: BuildContextOptions): ProviderContext {
  const { manifest, definition, connection } = options;
  const namespace = scopeNamespace(manifest.id, connection.id);

  const info: ConnectionInfo = {
    id: connection.id,
    key: `${manifest.id}.${connection.id}`,
    displayName: connection.account,
    config: connection.config ?? {},
  };

  return {
    connection: info,
    profiles: options.profiles,
    state: createScopedStore(options.state, namespace),
    storage: scopeBlobStore(options.storage, namespace),
    credentials: scopeSecrets(
      options.credentials,
      resolveSecretRefs(manifest, connection, definition, options.ownClients ?? []),
    ),
    audit: options.audit,
    log: options.log,
    signal: options.signal,
    ...(options.authorize ? { authorize: options.authorize } : {}),
  };
}

/** A logger that prefixes provider and connection, so lines are attributable. */
export function createProviderLogger(base: Logger, provider: string, connection: string): Logger {
  const prefix = `[${provider}.${connection}]`;
  return {
    debug: (message, detail) => base.debug(`${prefix} ${message}`, detail),
    info: (message, detail) => base.info(`${prefix} ${message}`, detail),
    warn: (message, detail) => base.warn(`${prefix} ${message}`, detail),
    error: (message, detail) => base.error(`${prefix} ${message}`, detail),
  };
}

export function createConsoleLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const threshold = order[level];

  const emit = (
    kind: keyof typeof order,
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    if (order[kind] < threshold) return;
    const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : '';
    // stderr throughout: stdout belongs to the CLI's own output, and a log line
    // interleaved into a printed token or config diff is worse than useless.
    process.stderr.write(`${kind.padEnd(5)} ${message}${suffix}\n`);
  };

  return {
    debug: (message, detail) => emit('debug', message, detail),
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
  };
}
