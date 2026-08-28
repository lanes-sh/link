import { ownerPrincipal } from '#auth';
import type { DiscoveredCapability } from '#connectivity';
import { allowedConnections } from '#policy';
import { toPolicyDocument } from '#registry';
import { capabilityDiff, discoveryProbe } from '../../runtime/discovery.ts';
import type { openRuntime } from '../../runtime.ts';

/**
 * The one thing `doctor` has to work out rather than simply read.
 *
 * Everything else in `inspect.ts` is a lookup — is the token there, does the
 * connection name a provider that exists — and this is an analysis: it diffs
 * what an upstream now offers against what the endpoint is serving. It is the
 * length in that file, and it is the part that changes for reasons the gate
 * order has nothing to do with.
 *
 * `credentialAge` used to sit beside it and date a credential from the OAuth
 * provider's stamp. It is gone: dating a credential answers "when did this last
 * refresh", which is not the question anyone was asking. `operate/auth.ts`
 * asks the real one by attempting the renewal.
 */

/**
 * Capabilities the upstream has grown since you connected.
 *
 * This is what replaced pinning an allow line per tool. `connect` writes
 * `provider.*`, which is readable and which a vendor can quietly widen by
 * shipping a new tool — so the widening has to be *visible* somewhere, and
 * doctor is where you look when you want to know what changed.
 *
 * Compared against the discovery cache rather than against config, because the
 * cache is what the running server actually serves. Failures are reported and
 * skipped: an upstream being down is not a reason for doctor to fail, and it is
 * already obvious from every other check.
 *
 * This used to open `if (kind !== 'mcp') continue`, which meant it watched the
 * one connector kind whose capabilities this repository does not ship and
 * ignored the two it does. Drive gained three operations in a commit and the
 * endpoint served six for as long as the operator did not re-authorise; the
 * check written to make exactly that visible never ran. `http` is no longer
 * listed here because it no longer can drift — `runtime/discovery.ts` re-derives
 * it at startup — so what is left is the kinds that genuinely still cache.
 */
export async function reportCapabilityDrift(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  say: (message: string) => void,
): Promise<void> {
  const policy = toPolicyDocument(runtime.config);
  const principal = ownerPrincipal(runtime.config.instance.profile).id;

  for (const entry of runtime.registry.list()) {
    const connection = runtime.config.connections.find((c) => c.provider === entry.manifest.id);
    if (!connection) continue;

    const connector = runtime.connectorFor(entry.manifest.id, connection.id);
    const probe = discoveryProbe(entry.manifest, connector);
    // Re-derived every startup, so what is served is what is shipped. Probing
    // it here would only ever compare a value against itself.
    if (!probe || probe.cost === 'offline') continue;

    const cached = runtime.registry.discovered(entry.manifest.id) ?? [];

    let live: readonly DiscoveredCapability[];
    try {
      live = await probe.run();
    } catch {
      continue;
    }

    // A provider that was never discovered serves nothing at all, which reads
    // from the outside like the provider being broken. Skipping it silently is
    // how that stays a mystery.
    if (cached.length === 0) {
      say(
        `${entry.manifest.name} has never been discovered, so none of its ${live.length} ` +
          `capability(ies) are served — run: lanes link connect ${entry.manifest.id}`,
      );
      continue;
    }

    const diff = capabilityDiff(cached, live);

    if (diff.added.length > 0) {
      // Through the same `allowedConnections` the dispatcher enforces with,
      // rather than reading `policy.allow` directly. The predicate this replaced
      // ignored its own `name` argument, so the answer was all-or-nothing, and
      // it never consulted `deny` — telling an operator their policy covered a
      // capability they had explicitly withheld.
      const reachable = diff.added.filter(
        (name) =>
          allowedConnections(
            `${entry.manifest.id}.${name}`,
            [`${entry.manifest.id}.${connection.id}`],
            principal,
            policy,
          ).length > 0,
      );

      say(
        `${entry.manifest.name} has ${diff.added.length} new capability(ies) since you connected: ` +
          `${diff.added.slice(0, 5).join(', ')}${diff.added.length > 5 ? ', …' : ''}` +
          (reachable.length > 0
            ? `\n      Your policy covers ${reachable.length} of them — lanes link policy deny ${entry.manifest.id}.<name> to withhold one.`
            : ''),
      );
    }

    if (diff.removed.length > 0) {
      say(`${entry.manifest.name} no longer offers: ${diff.removed.slice(0, 5).join(', ')}`);
    }

    // The case ADR-017 said `plan` structurally could not report: a schema or a
    // description moved, the name did not, and the endpoint is serving the old
    // shape until it restarts.
    if (diff.changed.length > 0) {
      say(
        `${entry.manifest.name} changed the shape of: ${diff.changed.slice(0, 5).join(', ')}` +
          `\n      Run: lanes link connect ${entry.manifest.id}, then restart the endpoint.`,
      );
    }
  }
}
