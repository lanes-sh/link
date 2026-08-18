/**
 * Connectivity types — one folder per way of reaching a service.
 *
 * See `README.md` for the table mapping each folder to the `connector.kind` an
 * operator writes, and for the rule that keeps vendor names out of all of them.
 */

export { createLocalConnector } from './local/index.ts';
export { createMcpConnector, inferBundle, type McpConnectorOptions } from './mcp/index.ts';
export {
  createHttpConnector,
  bundleForMethod,
  globMatches,
  type HttpConnectorOptions,
} from './http/index.ts';
export { createImapConnector, type ImapConnectorOptions } from './imap/index.ts';
export { createDavConnector, type DavConnectorOptions } from './dav/index.ts';
export { createFsConnector, type FsConnectorOptions } from './fs/index.ts';
export { type ImapCredential } from './imap/client.ts';
export { connectorFactory, type ConnectorFactory, type ConnectorFactoryOptions } from './factory.ts';
