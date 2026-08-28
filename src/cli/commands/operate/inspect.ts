import { credentialRefFor, formatPlan, planIsNoop, planReconcile } from '#registry';
import { DEFAULT_SURFACES } from '../../config-repair.ts';
import { announce, announceProfile, emit, fail, ok, print, warn } from '../../output.ts';
import { staleNudge } from '../../release.ts';
import { openRuntime, resolveProfileOnly, type GlobalFlags, type Runtime } from '../../runtime.ts';
import type { FetchLike } from '#deployments/knowledge.ts';
import { unboundRotatableRefs } from '#deployments/bind.ts';
import { credentialAge, reportCapabilityDrift } from './findings.ts';
import { migratedContract, migratedRenamedProviders } from './migrate.ts';

/**
 * The gate order — check, doctor, plan, start — exists so failures surface in
 * the cheapest place first: static validation before any external call, and a
 * preview of what reconcile would change before it changes anything.
 */

/** Static validation only. No external calls, no database, no credentials. */
export async function check(flags: GlobalFlags): Promise<void> {
  const { selection, config } = await resolveProfileOnly(flags);
  announceProfile(selection);

  // Reaching here means the loader accepted it: contract major, no credential
  // values, and referential integrity all passed. Not target resolution — this
  // validates a file, and the file is the same whichever target reads it.
  print(ok(`${selection.profilePath} is valid`));
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
  /** Apply a repair `doctor` would otherwise only report. */
  readonly fix?: boolean | undefined;
  /** Injected for tests. A knowledge repository is the only thing doctor fetches. */
  readonly fetch?: FetchLike | undefined;
}

/**
 * One thing doctor found: what is wrong, and the command that fixes it.
 *
 * `fix` carries both flags. That used to be an argument about JSON callers —
 * a person reading the terminal had just resolved a profile and their next
 * command would resolve the same one, while a parser had no shell context. The
 * argument is moot now: nothing resolves on its own (ADR-037), so a command
 * without them refuses whoever runs it. What survives is the shape.
 */
export interface DoctorFinding {
  readonly kind: string;
  readonly message: string;
  readonly key?: string;
  readonly fix?: string;
}

/** Read-only external checks: credentials resolve, stores reachable. */
export async function doctor(flags: DoctorFlags): Promise<void> {
  // The one check that cannot use a runtime, because it answers for the profiles
  // that cannot open one. A provider rename left in the config refuses at load,
  // which takes every command down together — including the rest of this one —
  // so it is asked first and, with `--fix`, undone. Anything else that refused
  // is rethrown untouched.
  let runtime: Runtime;
  try {
    runtime = await openRuntime(flags, { fetch: flags.fetch });
  } catch (refusal) {
    // Contract first: it is checked before the schema, so a profile carrying
    // both problems reports the contract one and the rename cannot be seen until
    // that is settled.
    if (await migratedContract(flags, refusal)) return;
    if (await migratedRenamedProviders(flags, refusal)) return;
    throw refusal;
  }

  const checks: string[] = [];
  const warnings: DoctorFinding[] = [];
  const problems: DoctorFinding[] = [];

  try {
    const forSelection = (command: string) =>
      `${command} --profile ${runtime.resolution.profile} --target ${runtime.resolution.target}`;

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
        fix: forSelection('lanes link token rotate'),
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
        //
        // Only for a client the operator registered. The hosted one is in
        // production and does not expire refresh tokens weekly, so this warning
        // would simply be false there — and a warning that is wrong once is a
        // warning that gets scrolled past every time after.
        if (staleness !== null && !staleness.brokered && staleness.days >= 7) {
          warnings.push({
            kind: 'stale_credential',
            key,
            message:
              `${key} credential is ${staleness.days} days old — a Google app in "Testing" expires at 7. ` +
              `Run: lanes link connect ${key}`,
            fix: forSelection(`lanes link connect ${key}`),
          });
        } else {
          const age = staleness
            ? ` (${staleness.days}d old${staleness.brokered ? ', hosted client' : ''})`
            : '';
          checks.push(`${key} credential resolves${age}`);
        }
      } else {
        problems.push({
          kind: 'missing_credential',
          key,
          message: `${key} has no stored credential — run: lanes link connect ${key}`,
          fix: forSelection(`lanes link connect ${key}`),
        });
      }
    }

    // A repository this profile stores memory and skills in is an external
    // dependency the other checks here do not cover, and it fails in the way
    // doctor exists for: a token expires, and memory stops working with nothing
    // said until the next read. One request answers all of it.
    if (runtime.knowledge) {
      try {
        const facts = await runtime.knowledge.repository.facts();

        if (!facts.canPush) {
          problems.push({
            kind: 'knowledge_read_only',
            key: facts.fullName,
            message:
              `memory and skills are kept in ${facts.fullName}, and the token can no longer write ` +
              'to it — writes will fail. Regenerate it with Contents: read and write, then run: ' +
              'lanes link knowledge use github --repo ' + facts.fullName + ' --replace',
            fix: forSelection(`lanes link knowledge use github --repo ${facts.fullName} --replace`),
          });
        } else if (!facts.private) {
          warnings.push({
            kind: 'knowledge_public',
            key: facts.fullName,
            message: `${facts.fullName} is public — every memory entry and skill in it is world-readable`,
          });
        } else {
          checks.push(`memory and skills reachable in ${facts.fullName}`);
        }
      } catch (error) {
        problems.push({
          kind: 'knowledge_unreachable',
          key: runtime.knowledge.describe,
          message:
            `memory and skills are kept in ${runtime.knowledge.describe}, which could not be ` +
            `reached: ${(error as Error).message}`,
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

    // A profile written before the owner layer was default has no connection row
    // for any of it, and `allowedConnections` returns nothing for a provider with
    // no connection *before* consulting policy — so the capabilities are simply
    // absent, with nothing saying why. An agent then has no memory to consult, no
    // list to add to, and no way to see what is configured, and starts guessing.
    //
    // Both halves, because either alone is inert: a connection row that no rule
    // grants serves nothing, and a rule naming a provider with no row is what
    // `allowedConnections` drops before policy is consulted. Reporting only the
    // row left the half-repaired profile reading as healthy while serving exactly
    // as little as the untouched one — and both halves are what
    // `ensureOwnerLayer` writes, so this is the check that says whether it ran.
    //
    // A surface the operator has *denied* is not missing, it is off, so a deny
    // covering it is not reported. That is the same rule the repair follows, and
    // reading it here from `policy.deny` rather than asking the repair keeps
    // `doctor` a read.
    const denied = (rule: string): boolean =>
      runtime.config.policy.deny.some(
        (entry) => entry.capability === '*' || entry.capability === rule,
      );

    const missing = DEFAULT_SURFACES.filter((provider) => {
      const rule = `${provider}.*`;
      if (denied(rule)) return false;

      const hasRow = runtime.config.connections.some(
        (connection) => connection.provider === provider,
      );
      const granted = runtime.config.policy.allow.some(
        (entry) => entry.capability === '*' || entry.capability === rule,
      );
      return !hasRow || !granted;
    });

    if (missing.length > 0) {
      warnings.push({
        kind: 'no_owner_layer',
        message:
          `this profile cannot reach its own ${missing.join(', ')} — ` +
          'the connection row or the allow rule is missing, and either alone serves nothing. ' +
          'Any of start, connect or deploy repairs it',
        fix: forSelection('lanes link start'),
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

    // Every finding above is about this profile; this one is about the binary
    // reading it. Silent when the registry cannot be reached — `doctor` is
    // expected to work on a plane, and "could not check" is not a finding.
    const stale = await staleNudge();
    if (stale !== null) warnings.push({ kind: 'stale_release', message: stale });

    await reportCapabilityDrift(runtime, (message) =>
      warnings.push({ kind: 'capability_drift', message }),
    );

    const drift = await planReconcile(runtime.config, runtime.state, runtime.credentials, runtime.manifestFor);
    if (!planIsNoop(drift)) {
      warnings.push({
        kind: 'reconcile_drift',
        message: 'runtime state differs from config — run: lanes link plan',
        fix: forSelection('lanes link plan'),
      });
    }

    // Whether the revision can still rewrite what it serves.
    //
    // A *problem*, not a warning: an unbound credential is a connection that
    // works until its access token expires and then stops, and every other
    // report on this machine calls it healthy in the meantime — `status` and
    // `setup_overview` read the state store, and the state store knows nothing
    // about IAM. This is the only place that asks the thing that decides.
    //
    // Skipped entirely for a local target, where credentials are a file this
    // process owns and there is no revision to grant anything to.
    const rotation = await unboundRotatableRefs({
      deploy: runtime.declared.deploy,
      target: runtime.target,
      connections: runtime.config.connections,
      manifestFor: runtime.manifestFor,
    });
    if (rotation.unbound.length > 0) {
      problems.push({
        kind: 'unbound_credentials',
        message:
          `the deployed endpoint can read ${rotation.unbound.join(', ')} but not rotate ` +
          `${rotation.unbound.length === 1 ? 'it' : 'them'} — so ${rotation.unbound.length === 1 ? 'that connection' : 'those connections'} ` +
          'will fail about an hour after each use, when the token refresh tries to persist. ' +
          'A connection made since the last deploy is the usual cause',
        fix: forSelection('lanes link deploy'),
      });
    }
    if (rotation.unavailable) {
      warnings.push({ kind: 'rotation_uncheckable', message: rotation.unavailable });
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
