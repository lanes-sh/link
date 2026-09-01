import { X509Certificate } from 'node:crypto';
import { PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF, readConnections } from '#profile';
import type { Runtime } from '#cli/runtime.ts';
import type { Logger } from '#connectivity';
import type { RunningServer } from '../index.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import { directPairingCredential } from './credential.ts';
import { serveRead, type RunningReadListener } from './listener.ts';

/**
 * The dashboard's read surface on loopback, if this workspace has been paired.
 *
 * Absent by default and absent for every workspace that has not run
 * `lanes link pair`, which is the whole shape of ADR-063: a browser origin
 * reaching loopback is a grant somebody makes deliberately, not a property of
 * running an endpoint. All three pieces must be present — the token and both
 * halves of the certificate — because a partial pairing would bind a port
 * serving something no browser will connect to.
 *
 * Bound one above the MCP port, and a failure to bind is reported rather than
 * fatal: the endpoint is what the operator ran this for, and refusing to serve
 * it because a second port is occupied would be the wrong trade.
 */
export async function openReadListener(
  primary: Runtime,
  server: RunningServer,
  profiles: () => ReadonlyMap<string, ProfileRuntime>,
  log: Logger,
  version: string,
): Promise<RunningReadListener | null> {
  // Loopback only, and checked before a single credential is read.
  //
  // A second TLS listener one port above the endpoint is a loopback-only
  // object: Cloud Run routes exactly one port, so there is nowhere for it to
  // bind. Reading the three refs regardless meant a deployed revision asked
  // Secret Manager for secrets no IAM binding covered — and Secret Manager
  // answers a missing binding with 403 rather than 404, so the rejection
  // escaped this function's try block, which wraps only `serveRead`, and the
  // revision never went healthy.
  //
  // A deployed workspace now serves the same routes through the endpoint's own
  // router (`./deployed.ts`), which reads no credential at boot at all — so
  // that failure cannot recur there by construction, and `readableRefs` binds
  // the token so the read itself stops being a rejection.
  const bound = new URL(server.url);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(bound.hostname)) return null;

  const [token, cert, key] = await Promise.all([
    primary.credentials.get(PAIR_TOKEN_REF),
    primary.credentials.get(PAIR_CERT_REF),
    primary.credentials.get(PAIR_KEY_REF),
  ]);

  if (token === null || cert === null || key === null) return null;

  try {
    return serveRead({
      host: bound.hostname,
      port: Number(bound.port) + 1,
      workspace: primary.target,
      profiles,
      audit: primary.audit,
      connections: async () =>
        (await readConnections(primary.resolution.workspaceRoot)).connections,
      // Read on every presentation, so `pair --rotate` takes effect on a
      // running endpoint. Affordable here because the store is a local file;
      // the deployed bind caches for exactly this reason. `refresh()` drops the
      // store's decrypted copy first, because the rotation was written by a
      // different process.
      credential: directPairingCredential({
        read: () => primary.credentials.get(PAIR_TOKEN_REF),
        refresh: () => primary.credentials.refresh?.(),
        onError: (reason) => log.warn('could not read the pairing credential', { reason }),
      }),
      endpoint: { kind: 'local', version, certificateExpiresAt: expiryOf(cert) },
      tls: { cert, key },
    });
  } catch (error) {
    log.warn('could not serve the dashboard read surface', {
      port: Number(bound.port) + 1,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * When the pairing certificate stops working, as an ISO instant.
 *
 * `null` rather than a throw for a certificate that cannot be parsed: the
 * surface it protects is already serving by the time anyone reads this, and
 * refusing to answer `/state` because an expiry could not be formatted would
 * take down the working thing to report on the broken one.
 */
function expiryOf(certificate: string): string | null {
  try {
    return new X509Certificate(certificate).validToDate.toISOString();
  } catch {
    return null;
  }
}
