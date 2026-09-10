import { X509Certificate } from 'node:crypto';
import { PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF } from '#profile';
import type { Runtime } from '#cli/runtime.ts';
import type { Logger } from '#connectivity';
import type { RunningServer } from '../index.ts';
import type { AuthorizationSurface } from '../oauth.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import type { DataSurface } from '#cli/owner-data/surface.ts';
import type { Authenticator } from '#auth';
import { connectionRows } from './connections.ts';
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
 * **The token is the opt-in marker and no longer a credential** (ADR-079).
 * Nothing on this port verifies it: a caller signs in and presents a bearer,
 * resolved by the endpoint's own authenticator. What it still does is record
 * that somebody ran `pair`, which is what keeps this port from appearing on
 * every endpoint that happens to be running. Retiring the ref altogether is a
 * separate change, because `deploy` binds it as a secret.
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
  authenticate: Authenticator['authenticate'],
  data?: DataSurface | undefined,
  authorization?: AuthorizationSurface | undefined,
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
      connections: () => connectionRows(primary),
      // The names the dashboard shows for a row nobody has labelled. From the
      // registry rather than a catalogue, so the owner layer, the vendors and a
      // workspace's own manifests are all named the same way.
      providerName: (id) => primary.registry.manifest(id)?.name,
      // Who is calling, resolved exactly as `/mcp` resolves it. The endpoint's
      // own authenticator, so a bearer works on both binds or on neither.
      authenticate,
      endpoint: { kind: 'local', version, certificateExpiresAt: expiryOf(cert) },
      ...(data ? { data } : {}),
      // **The authorization paths, on this port too.** A page on
      // `https://lanes.sh` cannot fetch `http://127.0.0.1:7337/register` —
      // mixed content, which is the same reason this bind exists at all — so
      // without them a browser could reach the surface and have no way to get a
      // credential for it. The MCP listener goes on serving them unchanged for
      // every client that already registered there; the store behind them is
      // one, so a token minted over either is the same token.
      ...(authorization ? { authorization } : {}),
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
