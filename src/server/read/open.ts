import { readConnections } from '#profile';
import type { Runtime } from '#cli/runtime.ts';
import {
  PAIR_CERT_REF,
  PAIR_KEY_REF,
  PAIR_TOKEN_REF,
} from '#cli/commands/operate/pair.ts';
import type { Logger } from '#connectivity';
import type { RunningServer } from '../index.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import { serveRead, type RunningReadListener } from './listener.ts';

/**
 * The dashboard's read surface, if this workspace has been paired.
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
): Promise<RunningReadListener | null> {
  // Loopback only, and checked before a single credential is read.
  //
  // Pairing exists so a browser can read an endpoint on *this machine*
  // (ADR-063); a deployed endpoint is already reachable by URL and `lanes link
  // pair` refuses to provision one. Reading the three refs regardless meant a
  // deployed revision asked Secret Manager for secrets no IAM binding covered —
  // and Secret Manager answers a missing binding with 403 rather than 404, so
  // the rejection escaped this function's try block, which wraps only
  // `serveRead`, and the revision never went healthy.
  //
  // Deriving the set for the IAM binding instead would have meant opening a
  // credential store inside `readableRefs`, which `--dry-run` reaches and must
  // not do.
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
      // Re-read rather than captured, so `pair --rotate` takes effect on a
      // running endpoint. `refresh()` drops the store's decrypted copy first,
      // because the rotation was written by a different process.
      token: async () => {
        primary.credentials.refresh?.();
        return primary.credentials.get(PAIR_TOKEN_REF);
      },
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
