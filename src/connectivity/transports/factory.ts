import type { AnyConnector, ProviderDefinition, ProviderManifest } from '#connectivity';
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

    const connector = wrap(entry.definition, build(entry.manifest, entry.definition, connectionId, options));
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
      });
  }
}
