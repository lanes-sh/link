import { ownerPrincipal } from '#auth';
import type { DiscoveredCapability } from '#connectivity';
import { allowedConnections } from '#policy';
import {
  credentialRefFor,
  formatPlan,
  planIsNoop,
  planReconcile,
  toPolicyDocument,
} from '#registry';
import { announce, emit, fail, ok, print, warn } from '../../output.ts';
import { capabilityDiff, discoveryProbe } from '../../runtime/discovery.ts';
import { openRuntime, resolveProfile, type GlobalFlags } from '../../runtime.ts';

/**
 * The gate order — check, doctor, plan, start — exists so failures surface in
 * the cheapest place first: static validation before any external call, and a
 * preview of what reconcile would change before it changes anything.
 */

/** Static validation only. No external calls, no database, no credentials. */
export async function check(flags: GlobalFlags): Promise<void> {
  const { resolution, config } = await resolveProfile(flags);
  announce(resolution);

  // Reaching here means the loader accepted it: contract major, no credential
  // values, referential integrity, and target resolution all passed.
  print(ok(`${resolution.profilePath} is valid`));
  print(
    `      ${config.connections.length} connection(s), ` +
      `${config.policy.allow.length} allow rule(s), ${config.policy.deny.length} deny rule(s)`,
  );
}

/** What reconcile would change, without changing it. */
export async function plan(flags: GlobalFlags): Promise<void> {
  const runtime = await openRuntime(flags);
  try {
    announce(runtime.resolution);
    const result = await planReconcile(runtime.config, runtime.state, runtime.credentials, runtime.manifestFor);
    print(formatPlan(result));
  } finally {
    await runtime.close();
  }
}

export interface DoctorFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
}

/**
 * One thing doctor found: what is wrong, and the command that fixes it.
 *
 * `fix` carries `--profile` while the printed line does not. A person reading
 * the terminal just resolved a profile to get here and their next command
 * resolves the same one; something parsing this JSON has no shell context at
 * all, so leaving it off would hand an agent a command that acts on whichever
 * profile happens to be the default.
 */
export interface DoctorFinding {
  readonly kind: string;
  readonly message: string;
  readonly key?: string;
  readonly fix?: string;
}

/** Read-only external checks: credentials resolve, stores reachable. */
export async function doctor(flags: DoctorFlags): Promise<void> {
  const runtime = await openRuntime(flags);

  const checks: string[] = [];
  const warnings: DoctorFinding[] = [];
  const problems: DoctorFinding[] = [];

  try {
    const forProfile = (command: string) =>
      `${command} --profile ${runtime.resolution.profile}`;

    checks.push('config is valid');
    checks.push('state store is reachable');

    const token = await runtime.credentials.get(runtime.config.auth.token_ref);
    if (token) {
      checks.push(`profile token present (${runtime.config.auth.token_ref})`);
    } else {
      // Not a failure: `lanes link start` mints one. Reporting it as a problem would
      // make every fresh profile fail doctor for something that fixes itself.
      warnings.push({
        kind: 'no_profile_token',
        message: 'no profile token yet — lanes link start will mint one, or run: lanes link token rotate',
        fix: forProfile('lanes link token rotate'),
      });
    }

    for (const connection of runtime.config.connections) {
      const key = `${connection.provider}.${connection.id}`;
      const ref = credentialRefFor(connection, runtime.manifestFor(connection.provider));
      if (!ref) {
        checks.push(`${key} needs no credential`);
        continue;
      }
      if (await runtime.credentials.has(ref)) {
        const staleness = await credentialAge(runtime.credentials, ref);

        // A Google project left in "Testing" expires refresh tokens after seven
        // days. That is a policy setting rather than a fault, but it presents
        // as an authentication failure mid-task — so say it before the call
        // fails rather than after.
        if (staleness !== null && staleness.days >= 7) {
          warnings.push({
            kind: 'stale_credential',
            key,
            message:
              `${key} credential is ${staleness.days} days old — a Google app in "Testing" expires at 7. ` +
              `Run: lanes link connect ${key}`,
            fix: forProfile(`lanes link connect ${key}`),
          });
        } else {
          checks.push(`${key} credential resolves${staleness ? ` (${staleness.days}d old)` : ''}`);
        }
      } else {
        problems.push({
          kind: 'missing_credential',
          key,
          message: `${key} has no stored credential — run: lanes link connect ${key}`,
          fix: forProfile(`lanes link connect ${key}`),
        });
      }
    }

    for (const name of new Set(runtime.config.connections.map((c) => c.provider))) {
      if (!runtime.registry.has(name)) {
        problems.push({
          kind: 'unknown_provider',
          key: name,
          message: `connection names provider "${name}", which is neither built in nor a manifest in providers/`,
        });
      }
    }

    // A profile written before the setup surface existed has no connection for
    // it, and `allowedConnections` returns nothing for a provider with no
    // connection *before* consulting policy — so the capabilities are simply
    // absent, with nothing saying why. An agent then has no way to see what is
    // configured and starts guessing at commands.
    //
    // Both halves, because either alone is inert: a connection row that no rule
    // grants serves nothing, and a rule naming a provider with no row is what
    // `allowedConnections` drops before policy is consulted. Reporting only the
    // row left the half-repaired profile reading as healthy while serving
    // exactly as little as the untouched one — and both halves are what
    // `ensureSetupConnection` writes, so this is the check that says whether it
    // has run.
    const hasSetupRow = runtime.config.connections.some(
      (connection) => connection.provider === 'setup',
    );
    const grantsSetup = runtime.config.policy.allow.some(
      (rule) => rule.capability === '*' || rule.capability === 'setup.*',
    );

    if (!hasSetupRow || !grantsSetup) {
      warnings.push({
        kind: 'no_setup_connection',
        message:
          `this profile ${hasSetupRow ? 'does not grant "setup.*"' : 'has no "setup" connection'}` +
          ', so an agent cannot see what is configured — run: lanes link connect setup',
        fix: forProfile('lanes link connect setup'),
      });
    }

    // Not a failure — nothing here needs the binary on PATH. But it is what
    // turns the registration command into a 401 that looks like a bad token,
    // so it is worth saying before someone is halfway through wiring an agent.
    if (!Bun.which('lanes')) {
      warnings.push({
        kind: 'not_on_path',
        message:
          'lanes is not on your PATH — "lanes link outputs" will print a longer command. ' +
          'Fix with: bun link (from the checkout)',
      });
    }

    await reportCapabilityDrift(runtime, (message) =>
      warnings.push({ kind: 'capability_drift', message }),
    );

    const drift = await planReconcile(runtime.config, runtime.state, runtime.credentials, runtime.manifestFor);
    if (!planIsNoop(drift)) {
      warnings.push({
        kind: 'reconcile_drift',
        message: 'runtime state differs from config — run: lanes link plan',
        fix: forProfile('lanes link plan'),
      });
    }

    if (problems.length > 0) process.exitCode = 1;

    return emit(flags.json, { ok: problems.length === 0, checks, warnings, problems }, () => {
      announce(runtime.resolution);

      for (const line of checks) print(ok(line));
      for (const finding of warnings) print(warn(finding.message));
      for (const finding of problems) print(fail(finding.message));

      if (problems.length > 0) {
        print();
        print(fail(`${problems.length} problem(s) found`));
      }
    });
  } finally {
    await runtime.close();
  }
}

/**
 * How old a stored OAuth credential is.
 *
 * Derived from the `expires_at` the OAuth provider stamps when saving tokens.
 * Returns null for anything that is not a token blob — an app password has no
 * meaningful age, and guessing one would produce a confusing warning.
 */
async function credentialAge(
  credentials: { get(ref: string): Promise<string | null> },
  ref: string,
): Promise<{ days: number } | null> {
  const raw = await credentials.get(ref);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { expires_at?: number; expires_in?: number };
    if (typeof parsed.expires_at !== 'number') return null;

    const issued = parsed.expires_at - (parsed.expires_in ?? 3600) * 1000;
    return { days: Math.floor((Date.now() - issued) / 86_400_000) };
  } catch {
    return null;
  }
}

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
async function reportCapabilityDrift(
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
