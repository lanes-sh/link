import type { AnyConnector, ProviderDefinition, ProviderManifest } from '#connectivity';
import { applyVariables } from '#connectivity/manifest/variables.ts';
import type { SecretStore } from '#secrets';
import type { ProviderRegistry } from '#registry';
import { basicCredential } from '#connectivity/auth/basic/index.ts';
import { bearerToken } from '#connectivity/auth/token.ts';
import { createCompositeConnector } from './composite/index.ts';
import { createDavConnector } from './dav/index.ts';
import { createFsConnector } from './fs/index.ts';
import { createHttpConnector } from './http/index.ts';
import { createImapConnector } from './imap/index.ts';
import { createLocalConnector } from './local/index.ts';
import { createMcpConnector } from './mcp/index.ts';

/**
 * Which transport a provider gets, and one instance of it per connection.
 *
 * The single place that turns a declared `connector.kind` into running code —
 * so the connectivity types are a closed set you can read off one switch, and
 * adding one is a folder beside this file plus a case below.
 */

export interface ConnectorFactoryOptions {
  readonly registry: ProviderRegistry;
  readonly credentials: SecretStore;
  /**
   * What one connection says about where its service is.
   *
   * Optional, and read only by a provider that declares `variables` — which is
   * a handful. A caller that omits it is saying every provider it serves has a
   * fixed address, which was true of all of them until Zendesk-shaped hosts
   * arrived, and is still true of almost all.
   */
  readonly connectionConfig?: (
    providerId: string,
    connectionId: string,
  ) => Readonly<Record<string, unknown>> | undefined;
  /**
   * Whether this connection is declared at all.
   *
   * Separate from its config, and the distinction is load-bearing: a provider
   * nobody has connected is not a misconfiguration — every surface that lists
   * what *could* be connected asks the factory about one — while a row that has
   * been declared and carries no address is exactly the case worth failing
   * loudly. Without this the two are indistinguishable, and the quiet answer
   * wins for both.
   */
  readonly isDeclared?: (providerId: string, connectionId: string) => boolean;
}

/**
 * Build connectors, memoised per provider *and* connection.
 *
 * The connection used to be fixed when the factory was constructed, which meant
 * every caller built a fresh factory — and therefore a fresh cache — for every
 * lookup, so nothing was ever reused. That went unnoticed because `mcp` and
 * `http` are request-shaped and a redundant instance costs nothing. `imap` holds
 * a socket, so the same bug would have meant a TLS handshake and a LOGIN per
 * tool call, against a server that throttles exactly that.
 *
 * Taking the connection as an argument is what makes one factory per runtime
 * possible, which is what makes the cache real.
 */
export interface ConnectorFactory {
  (providerId: string, connectionId: string): AnyConnector | undefined;
  /**
   * Close every connector that holds a session.
   *
   * Only a stateful kind implements `close`; for the rest this is a no-op. A
   * failure to close is swallowed — the process is going away, and a socket that
   * cannot be shut down cleanly is not a reason to fail the command that was
   * already finished.
   */
  closeAll(): Promise<void>;
}

export function connectorFactory(options: ConnectorFactoryOptions): ConnectorFactory {
  const cache = new Map<string, AnyConnector>();

  const factory = (providerId: string, connectionId: string): AnyConnector | undefined => {
    const key = `${providerId}.${connectionId}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const entry = options.registry.get(providerId);
    if (!entry) return undefined;

    // Filled in before the switch, so no transport case knows this happened —
    // which is the property worth keeping. A variable changes *where* a
    // connector points, and nothing about how it speaks.
    const manifest = fillAddress(entry.manifest, providerId, connectionId, options);
    if (!manifest) return undefined;

    const connector = wrap(entry.definition, build(manifest, entry.definition, connectionId, options));
    if (connector) cache.set(key, connector);
    return connector;
  };

  factory.closeAll = async (): Promise<void> => {
    await Promise.all(
      [...cache.values()].map(async (connector) => {
        try {
          await connector.close?.();
        } catch {
          /* see above */
        }
      }),
    );
    cache.clear();
  };

  return factory;
}

/**
 * Substitute what this connection says about where its service is.
 *
 * Returns the manifest itself when it declares no variables, which is the
 * overwhelming majority — so the cost is one array check per connector built,
 * and a provider with a fixed address cannot be affected by any of this.
 *
 * A missing or malformed value throws, and throwing here is deliberate. The
 * alternative is a connector pointed at `{site}.zendesk.com`, which fails as a
 * DNS error at the first call and says nothing about the real problem; this
 * fails at construction, naming the variable and what it should look like.
 */
function fillAddress(
  manifest: ProviderManifest,
  providerId: string,
  connectionId: string,
  options: ConnectorFactoryOptions,
): ProviderManifest | undefined {
  if (manifest.variables.length === 0) return manifest;

  const values = options.connectionConfig?.(providerId, connectionId) ?? {};

  // A provider nobody has connected has no address and that is not an error:
  // the dashboard asks the factory about every provider it lists, and a throw
  // here took the whole page down rather than showing one as unconnected.
  //
  // A *declared* connection missing its address is the opposite, and used to be
  // silent for the same reason — which is how a `connect` that never wrote the
  // value produced a provider that was simply, wordlessly dead.
  if (Object.keys(values).length === 0 && !options.isDeclared?.(providerId, connectionId)) {
    return undefined;
  }
  const connector = applyVariables(
    manifest.connector as unknown as Record<string, unknown>,
    manifest.variables,
    values,
  );

  // The cast is honest: `applyVariables` rewrites string fields in place and
  // never touches `kind`, so the union member is the one it started as.
  return { ...manifest, connector: connector as unknown as ProviderManifest['connector'] };
}

/**
 * Layer a provider's own capabilities over a remote connector.
 *
 * Only when it has both, which is neither of the two common cases: `local` is
 * already all authored code, and a manifest-only provider has nothing to layer.
 * What is left is a remote provider carrying a handful of authored capabilities
 * because the vendor's API can do something its document cannot describe — see
 * `composite/index.ts`.
 */
function wrap(
  definition: ProviderDefinition | undefined,
  remote: AnyConnector | undefined,
): AnyConnector | undefined {
  if (!remote || !definition || definition.capabilities.length === 0) return remote;
  if (remote.kind === 'local') return remote;

  return createCompositeConnector({ definition, remote });
}

function build(
  manifest: ProviderManifest,
  definition: ProviderDefinition | undefined,
  connectionId: string,
  options: ConnectorFactoryOptions,
): AnyConnector | undefined {
  switch (manifest.connector.kind) {
    case 'local':
      return definition ? createLocalConnector(definition) : undefined;

    case 'mcp':
      return createMcpConnector({
        endpoint: manifest.connector.endpoint,
        ...(manifest.connector.headers ? { headers: manifest.connector.headers } : {}),
        // Not `resolveUpstreamToken` directly: that one answers only for OAuth,
        // and returns null for a provider whose token the operator pasted —
        // which reaches the server as a missing header rather than an error.
        accessToken: () => bearerToken(manifest, connectionId, options.credentials),
      });

    case 'imap':
      return createImapConnector({
        host: manifest.connector.host,
        port: manifest.connector.port,
        maxBodyBytes: manifest.connector.max_body_bytes,
        ...(manifest.setup?.troubleshooting !== undefined
          ? { troubleshooting: manifest.setup.troubleshooting }
          : {}),
        // Mapped rather than passed through: the manifest is snake_case and the
        // transport option is not, the same way `max_body_bytes` is above.
        ...(manifest.connector.smtp
          ? {
              smtp: {
                host: manifest.connector.smtp.host,
                port: manifest.connector.smtp.port,
                starttls: manifest.connector.smtp.starttls,
                maxMessageBytes: manifest.connector.smtp.max_message_bytes,
              },
            }
          : {}),
        // The same seam `createMcpConnector` uses for its token: a credential
        // arrives as a constructor option, bound to one account, because IMAP
        // has no Request to hand an authorizer and no headers to get back.
        credential: () => basicCredential(manifest, connectionId, options.credentials),
      });

    case 'dav':
      // No credential option: DAV is HTTPS, so `context.authorize` attaches
      // Basic auth and the connector never sees one.
      return createDavConnector({
        baseUrl: manifest.connector.base_url,
        service: manifest.connector.service,
        maxRangeDays: manifest.connector.max_range_days,
        ...(manifest.setup?.troubleshooting !== undefined
          ? { troubleshooting: manifest.setup.troubleshooting }
          : {}),
        // Only for the connect-time credential check and the account label;
        // every operation still goes through `context.authorize`.
        credential: () => basicCredential(manifest, connectionId, options.credentials),
      });

    case 'fs':
      return createFsConnector({
        root: manifest.connector.root,
        maxFileBytes: manifest.connector.max_file_bytes,
        exclude: manifest.connector.exclude,
        ...(manifest.connector.placeholder ? { placeholder: manifest.connector.placeholder } : {}),
      });

    case 'http':
      return createHttpConnector({
        baseUrl: manifest.connector.base_url,
        openapi: manifest.connector.openapi,
        ...(manifest.connector.operations?.include?.length
          ? { include: manifest.connector.operations.include }
          : {}),
        ...(manifest.connector.operations?.exclude?.length
          ? { exclude: manifest.connector.operations.exclude }
          : {}),
        ...(manifest.connector.headers ? { headers: manifest.connector.headers } : {}),
      });
  }
}
