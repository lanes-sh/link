import { formatPlan, planIsNoop, planReconcile } from '#registry';
import { readEndpointTokens, type ConnectionConfig, type SelectedConnection } from '#profile';
import { DEFAULT_SURFACES } from '../../config-repair.ts';
import { announce, announceProfile, emit, fail, ok, print, warn } from '../../output.ts';
import { staleNudge } from '../../release.ts';
import { openRuntime, resolveProfileOnly, type GlobalFlags, type Runtime } from '../../runtime.ts';
import type { FetchLike } from '#deployments/knowledge.ts';
import { unboundRotatableRefs } from '#deployments/bind.ts';
import { reportCapabilityDrift } from './findings.ts';
import { probeConnections } from './auth.ts';
import { migratedContract, migratedRenamedProviders } from './migrate.ts';

/**
 * The gate order — check, doctor, plan, start — exists so failures surface in
 * the cheapest place first: static validation before any external call, and a
 * preview of what reconcile would change before it changes anything.
 */

/** Static validation only. No external calls, no database, no credentials. */
/**
 * The accounts this profile actually reaches, as reconcile wants them.
 *
 * A profile grants a subset of the workspace's connections (ADR-057), and
 * reconcile is about the ones it reaches: an account granted to nobody has no
 * state to keep in step, and marking it `disabled` here would fight with the
 * profile next door that does grant it.
 */
function grantedConnections(runtime: { connections: readonly SelectedConnection[] }): ConnectionConfig[] {
  return runtime.connections.map(({ connection }) => connection);
}

export async function check(flags: GlobalFlags): Promise<void> {
  const { selection, config } = await resolveProfileOnly(flags);
  announceProfile(selection);

  // Reaching here means the loader accepted it: contract major, no credential
  // values, and referential integrity all passed. Not target resolution — this
  // validates a file, and the file is the same whichever target reads it.
  print(ok(`${selection.profilePath} is valid`));
  print(
    `      ${config.grants.length} grant(s), ` +
      `${config.grants.reduce((n, g) => n + g.allow.length, 0)} allow rule(s), ` +
      `${config.grants.reduce((n, g) => n + g.deny.length, 0)} deny rule(s), ` +
      `${config.members.length} member(s)`,
  );
}

/** What reconcile would change, without changing it. */
export async function plan(flags: GlobalFlags): Promise<void> {
  const runtime = await openRuntime(flags);
  try {
    announce(runtime.resolution);
    const result = await planReconcile(grantedConnections(runtime), runtime.state, runtime.credentials, runtime.manifestFor);
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

/**
 * External checks: credentials still authenticate, stores reachable.
 *
 * Not read-only, and that changed when the credential check stopped guessing
 * from a stored date and started attempting the renewal. A refresh that
 * succeeds persists the new token, which on a deployed target is a secret-store
 * write. It is the same write serving a request makes, and it warms the token
 * for the next real call — but `check` and `plan` above are still the two that
 * touch nothing.
 */
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
      `${command} --profile ${runtime.resolution.profile} --workspace ${runtime.resolution.target}`;

    checks.push('config is valid');
    checks.push('state store is reachable');

    // **A row whose value is missing, not a missing token** (ADR-068). Having
    // issued none is the healthy default — a client signs in for itself — so
    // reporting that as a problem would make every working workspace fail
    // doctor. What is genuinely broken is a row pointing at nothing: it matches
    // no credential, and from the client's side reads exactly like a wrong
    // token. That is what a half-finished `secrets push` leaves behind.
    const issued = await readEndpointTokens(runtime.resolution.workspaceRoot);
    const orphaned: string[] = [];
    for (const row of issued) {
      if ((await runtime.credentials.get(row.ref)) === null) orphaned.push(row.id);
    }

    if (issued.length > 0 && orphaned.length === 0) {
      checks.push(`${issued.length} endpoint token(s) present`);
    }

    for (const id of orphaned) {
      warnings.push({
        kind: 'orphaned_endpoint_token',
        message: `token "${id}" has a row but no value in this workspace's store — it matches nothing`,
        fix: `lanes link token rotate --id ${id} --workspace ${runtime.resolution.target}`,
      });
    }

    // Whether each credential still works, asked rather than dated.
    //
    // This used to warn from the *age* of a stored credential, on the theory
    // that a Google app left in "Testing" expires refresh tokens at seven days.
    // The heuristic was wrong in both directions — it dated a credential from
    // its last refresh, so an untouched healthy connection read as stale and a
    // grant revoked an hour ago read as fresh — and its own guard made it worse:
    // it skipped brokered credentials because "the hosted client is in
    // production", which `providers/google/shared/oauth.ts` now says outright is
    // not so. The hosted client is under review and carries the same weekly
    // expiry, so the warning was silenced for exactly the population that has
    // the problem.
    //
    // `probeConnections` answers it by attempting the renewal, which is the only
    // thing that actually knows. Same classifier as `lanes link auth`, so the two
    // cannot drift apart again.
    const probed = await probeConnections(runtime, grantedConnections(runtime), forSelection);

    for (const result of probed) {
      switch (result.verdict) {
        case 'reauth':
          warnings.push({
            kind: 'needs_reauth',
            key: result.key,
            message:
              `${result.key} is signed out and cannot renew itself — run: lanes link connect ${result.key}` +
              (result.detail ? `\n      ${result.detail}` : ''),
            fix: forSelection(`lanes link connect ${result.key}`),
          });
          break;
        case 'missing':
          problems.push({
            kind: 'missing_credential',
            key: result.key,
            message: `${result.key} has no stored credential — run: lanes link connect ${result.key}`,
            fix: forSelection(`lanes link connect ${result.key}`),
          });
          break;
        case 'none':
          checks.push(`${result.key} needs no credential`);
          break;
        case 'unknown':
          warnings.push({
            kind: 'auth_uncheckable',
            key: result.key,
            message: `${result.key} could not be checked${result.detail ? `: ${result.detail}` : ''}`,
          });
          break;
        default:
          checks.push(`${result.key} credential resolves`);
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

    for (const name of new Set(grantedConnections(runtime).map((one) => one.provider))) {
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
    // A grant row *is* the connection and the rule together now (ADR-058), so
    // "has a row but no rule" is a state that stopped existing — which removes
    // the half-repaired case this check was originally written for. What is left
    // is one question per surface: does this profile grant one, and is the grant
    // more than a deny.
    const grantFor = (provider: string) =>
      runtime.config.grants.find((grant) => grant.connection.startsWith(`${provider}.`));

    const missing = DEFAULT_SURFACES.filter((provider) => {
      const grant = grantFor(provider);
      if (grant === undefined) return true;

      const rule = `${provider}.*`;
      const denied = grant.deny.some(
        (entry) => entry.capability === '*' || entry.capability === rule,
      );
      if (denied) return false;

      return !grant.allow.some((entry) => entry.capability === '*' || entry.capability === rule);
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

    const drift = await planReconcile(grantedConnections(runtime), runtime.state, runtime.credentials, runtime.manifestFor);
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
      connections: grantedConnections(runtime),
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
