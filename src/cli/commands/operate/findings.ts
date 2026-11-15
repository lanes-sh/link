import { grantedConnections } from '../../runtime.ts';
import { connectionRefOf, duplicateAccountRows, type ConnectionConfig } from '#profile';
import { ownerPrincipal } from '#auth';
import type { DiscoveredCapability } from '#connectivity';
import { allowedConnections } from '#policy';
import { toPolicyDocument } from '#registry';
import { capabilityDiff, discoveryProbe } from '../../runtime/discovery.ts';
import { unboundRotatableRefs } from '#deployments/bind.ts';
import { waiting } from '../../output.ts';
import { mapWithLimit, withinTime } from './pool.ts';
import type { openRuntime } from '../../runtime.ts';
import type { DoctorFinding } from './inspect.ts';

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
 * refresh", which is not the question anyone was asking. `operate/connection-probe.ts`
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
/**
 * How many providers to ask at once.
 *
 * Lower than the credential probe's six: that one re-reads a stored token per
 * connection, and this one opens a session against somebody else's server. The
 * ceiling is about not arriving at a vendor as a burst, not about this machine.
 */
const DRIFT_CONCURRENCY = 4;

/**
 * How long one provider may take before it is passed over.
 *
 * Longer than the credential probe's eight seconds, because this is a
 * handshake and a listing rather than a token read, and a slow vendor
 * answering in ten seconds is still an answer worth having. What it bounds is
 * the vendor that never answers at all.
 */
const PER_PROBE_TIMEOUT_MS = 15_000;

export async function reportCapabilityDrift(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  say: (message: string) => void,
): Promise<void> {
  const policy = toPolicyDocument(runtime.config);
  const principal = ownerPrincipal(runtime.config.instance.profile).id;

  // Every provider worth asking, settled before anything is asked, so the
  // round trips below can overlap.
  const candidates = runtime.registry.list().flatMap((entry) => {
    const connection = grantedConnections(runtime).find((c) => c.provider === entry.manifest.id);
    if (!connection) return [];

    const connector = runtime.connectorFor(entry.manifest.id, connection.id);
    const probe = discoveryProbe(entry.manifest, connector);
    // Re-derived every startup, so what is served is what is shipped. Probing
    // it here would only ever compare a value against itself.
    if (!probe || probe.cost === 'offline') return [];

    return [{ entry, connection, probe }];
  });

  /**
   * Asked concurrently and under a clock, which this loop had neither of.
   *
   * It ran one provider at a time with nothing bounding any of them, and
   * `probe.run()` on an MCP provider is much more than a `tools/list`: it
   * resolves the credential, connects with version negotiation that falls back
   * to the legacy handshake, lists, and closes. Serial handshakes across a
   * provider list that is mostly remote vendors put a workspace with real
   * connections into minutes, and one vendor that accepted the connection and
   * never answered held it there indefinitely — the `catch` below can skip a
   * provider that *fails*, and has nothing to say about one that simply never
   * returns.
   *
   * `null` is "could not ask", which is deliberately the same answer for a
   * refusal and for a timeout: an upstream being down is not a reason for
   * `doctor` to fail, and it is already obvious from every other check.
   */
  const probed = await mapWithLimit(candidates, DRIFT_CONCURRENCY, async (candidate) =>
    withinTime(PER_PROBE_TIMEOUT_MS, null, async () => {
      try {
        return await candidate.probe.run();
      } catch {
        return null;
      }
    }),
  );

  // Reported in registry order rather than in the order the probes happened to
  // settle, so two runs against the same workspace read the same way.
  for (const [index, candidate] of candidates.entries()) {
    const { entry, connection } = candidate;
    const live: readonly DiscoveredCapability[] | null = probed[index] ?? null;
    if (live === null) continue;

    const cached = runtime.registry.discovered(entry.manifest.id) ?? [];

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

/**
 * One account declared twice under one provider — the same connection, twice.
 *
 * Reported rather than refused, which is why this is a finding and not a rule
 * in `assertConnectionsUnique`. That one runs at load and on every
 * `ConfigDocument.open`, so making this an error would take a workspace that
 * already holds a pair off the air — and refuse `disconnect` the very file that
 * fixes it. Both rows resolve and both work; what is wrong is that only one of
 * them holds a credential anybody has re-entered lately.
 *
 * A `<provider>.<id>` is unique by construction, so this is the only shape the
 * duplicate can take, and until `connect` preferred a provider's own row over a
 * vendor sibling's it is the shape a reconnect left behind.
 *
 * **No `fix` command, deliberately.** Which row to keep is not in the file: the
 * one to remove is the one whose credential is stale, and a `disconnect`
 * suggested from here would name the wrong one about half the time — which
 * `--fix` would then run.
 */
export function duplicateAccountFindings(
  connections: readonly ConnectionConfig[],
): DoctorFinding[] {
  return duplicateAccountRows(connections).map((group) => {
    const refs = group.map(connectionRefOf);
    return {
      kind: 'duplicate_account',
      key: refs[0]!,
      message:
        `${refs.join(' and ')} are one account declared twice (${group[0]!.account}) — ` +
        `remove whichever no longer holds a working credential with "lanes link disconnect <ref>"`,
    };
  });
}

/**
 * Whether the revision can still rewrite what it serves.
 *
 * A *problem*, not a warning: an unbound credential is a connection that works
 * until its access token expires and then stops, and every other report on this
 * machine calls it healthy in the meantime — `status` and `setup_overview` read
 * the state store, and the state store knows nothing about IAM. This is the only
 * place that asks the thing that decides.
 *
 * Skipped entirely for a local target, where credentials are a file this process
 * owns and there is no revision to grant anything to.
 *
 * Here rather than in `inspect.ts` for the reason `reportCapabilityDrift` is:
 * that file holds the gate order, this one holds the analysis, and the size
 * budget in `architecture.test.ts` is what keeps the seam honest.
 */
export async function reportUnboundCredentials(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  forSelection: (command: string) => string,
  into: { problems: DoctorFinding[]; warnings: DoctorFinding[] },
): Promise<void> {
  const rotation = await waiting('asking which credentials the endpoint may rewrite', () =>
    unboundRotatableRefs({
      deploy: runtime.declared.deploy,
      target: runtime.target,
      connections: grantedConnections(runtime),
      manifestFor: runtime.manifestFor,
    }),
  );

  if (rotation.unbound.length > 0) {
    const one = rotation.unbound.length === 1;
    into.problems.push({
      kind: 'unbound_credentials',
      message:
        `the deployed endpoint can read ${rotation.unbound.join(', ')} but not rotate ` +
        `${one ? 'it' : 'them'} — so ${one ? 'that connection' : 'those connections'} ` +
        'will fail about an hour after each use, when the token refresh tries to persist. ' +
        'A connection made since the last deploy is the usual cause',
      fix: forSelection('lanes link deploy'),
    });
  }

  if (rotation.unavailable) {
    into.warnings.push({ kind: 'rotation_uncheckable', message: rotation.unavailable });
  }
}
