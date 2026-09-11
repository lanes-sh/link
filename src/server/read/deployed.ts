import type { Runtime } from '#cli/runtime.ts';
import type { Logger } from '#connectivity';
import type { Authenticator } from '#auth';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import { MCP_PATH } from '../index.ts';
import { publicOrigin } from '../oauth.ts';
import { connectionRows } from './connections.ts';
import type { ReadDeps } from './routes.ts';
import type { DataSurface } from '#cli/owner-data/surface.ts';

/**
 * The same read surface, on a deployed endpoint's own port (ADR-064).
 *
 * Its sibling `./open.ts` binds a second TLS listener and cannot be used here:
 * Cloud Run routes exactly one port. So this returns dependencies rather than a
 * socket, and the router serves these paths through the endpoint's *own*
 * authenticator — the same one `/mcp` uses (ADR-079). There is nothing left
 * here that a shared check could confuse, because there is only one check.
 *
 * **Nothing here reads a credential**, and now nothing here holds one either.
 * The pairing token used to be read per request behind a verifier, cached so a
 * dashboard poll was not a Secret Manager round trip apiece. A bearer is
 * resolved by the authenticator, which does its own caching for the same
 * reason, so this is one fewer credential to provision, bind and rotate.
 *
 * Handed to `serve()`, which discards it on a loopback bind — beside `cors`,
 * `allowedHostnames` and `meterUnauthenticated`, because it is the same kind of
 * fact about the same address.
 */
export function deployedReadDeps(input: {
  readonly primary: Runtime;
  readonly profiles: () => ReadonlyMap<string, ProfileRuntime>;
  readonly log: Logger;
  /** The endpoint's own, so both surfaces resolve a caller identically. */
  readonly authenticate: Authenticator['authenticate'];
  readonly version: string;
  /** The owner's data, when the endpoint wired it. Absent means `/data` is a 404. */
  readonly data?: DataSurface | undefined;
}): ReadDeps {
  const { primary, log } = input;

  return {
    workspace: primary.target,
    profiles: input.profiles,
    audit: primary.audit,
    connections: () => connectionRows(primary),
    // The names the dashboard shows for a row nobody has labelled. From the
    // registry rather than a catalogue, so the owner layer, the vendors and a
    // workspace's own manifests are all named the same way.
    providerName: (id) => primary.registry.manifest(id)?.name,
    authenticate: input.authenticate,
    // Same origin as `/mcp` here, so the same derivation. Cloud Run routes one
    // port and these paths hang off it.
    resource: (request) => `${publicOrigin(request)}${MCP_PATH}`,
    endpoint: { kind: 'deployed', version: input.version, certificateExpiresAt: null },
    ...(input.data ? { data: input.data } : {}),
    log,
  };
}
