import { PAIR_TOKEN_REF, readConnections } from '#profile';
import type { Runtime } from '#cli/runtime.ts';
import type { Logger } from '#connectivity';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import { cachedPairingCredential } from './credential.ts';
import type { ReadDeps } from './routes.ts';

/**
 * The same read surface, on a deployed endpoint's own port (ADR-064).
 *
 * Its sibling `./open.ts` binds a second TLS listener and cannot be used here:
 * Cloud Run routes exactly one port. So this returns dependencies rather than a
 * socket, and the router serves the two paths in front of its own bearer gate —
 * the pairing token never passes through the endpoint's authenticator, because
 * one shared check would make each credential able to do the other's job.
 *
 * **Nothing here reads a credential.** That is the structural half of the fix
 * `./open.ts` describes: the pairing token is read per request, behind a
 * verifier, so a Secret Manager rejection can fail a request and can no longer
 * fail a boot. Adding `PAIR_TOKEN_REF` to `readableRefs` is the other half, and
 * it stops the rejection happening at all — a bound secret with no version
 * answers 404 and reads back as `null`, which is the never-paired case and
 * renders as an ordinary `401`.
 *
 * Handed to `serve()`, which discards it on a loopback bind — beside `cors`,
 * `allowedHostnames` and `meterUnauthenticated`, because it is the same kind of
 * fact about the same address.
 */
export function deployedReadDeps(input: {
  readonly primary: Runtime;
  readonly profiles: () => ReadonlyMap<string, ProfileRuntime>;
  readonly log: Logger;
  readonly version: string;
}): ReadDeps {
  const { primary, log } = input;

  return {
    workspace: primary.target,
    profiles: input.profiles,
    audit: primary.audit,
    connections: async () =>
      (await readConnections(primary.resolution.workspaceRoot)).connections,
    // Cached, unlike loopback's. `GcpSecretManagerStore` holds nothing between
    // calls, so a dashboard polling `/state` would be one network round trip per
    // poll and a stranger sending a wrong token one per request — which is the
    // ADR-054 hazard exactly: a costly read performed for a caller who has
    // presented nothing valid.
    credential: cachedPairingCredential({
      read: () => primary.credentials.get(PAIR_TOKEN_REF),
      refresh: () => primary.credentials.refresh?.(),
      onError: (reason) => log.warn('could not read the pairing credential', { reason }),
    }),
    endpoint: { kind: 'deployed', version: input.version, certificateExpiresAt: null },
    log,
  };
}
