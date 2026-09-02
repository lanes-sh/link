import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { installRoot, resolveWorkspaceRoot } from '#profile';
import { repairOwnerLayer } from '../config-repair-sweep.ts';
import { migrateToCurrentContract, needsMigration, type ContractMigration } from '../workspace-migrate.ts';
import { needsContract3, type Contract3Migration } from '../contract3.ts';
import { needsContract4 } from '../contract4.ts';
import { emit, fail, ok, print, printErr, progress, style, warn } from '../output.ts';
import { PACKAGE, release, type ReleaseState } from '../release.ts';
import { version } from '../version.ts';
import { readSession } from '#auth/lanes/session.ts';

/**
 * `lanes link update` — install the newer release, or say why it will not.
 *
 * There is no build step and no compiled artifact, so updating means exactly
 * one thing: replace the installed package directory with a newer tarball from
 * the registry. `bin/lanes` resolves its own symlink chain and execs Bun on the
 * `src/` inside that directory, so the shipped source *is* the running code and
 * the symlink on the PATH never has to move.
 *
 * Bun is the only installer this drives. `bun install -g @lanes-sh/link` is the
 * only install documented, `engines.bun` requires it, and the shim refuses to
 * run without it — so inferring a package manager would be machinery serving a
 * case nobody is told to create. The case that does exist is handled below
 * rather than ignored: an `npm i -g` install updated with Bun gets a second
 * copy somewhere else on the PATH, which this detects and reports instead of
 * doing quietly.
 *
 * Nothing here is control plane — it touches the install, not a profile — so it
 * resolves no profile and no target, and is the second command after `version`
 * that prints no `announce` line.
 */

export interface UpdateFlags {
  /** Report and exit without installing anything. */
  readonly check?: boolean | undefined;
  readonly json?: boolean | undefined;
}

/**
 * What `update` would do, and why.
 *
 * `'checkout'` is a refusal: `bun link` puts a checkout on the same PATH entry
 * a published install would occupy, so installing from the registry there would
 * leave two copies of this CLI and no indication of which one answers. `git
 * pull` is the update in a checkout, and saying so is more useful than doing
 * something surprising.
 */
export type UpdateAction = 'install' | 'current' | 'ahead' | 'checkout' | 'unknown';

export interface UpdateDecision {
  readonly action: UpdateAction;
  /** The argv to run, or `null` when nothing should be run. */
  readonly install: readonly string[] | null;
  readonly message: string;
  /** Something true and unwelcome about this install, if there is anything. */
  readonly warning: string | null;
}

export interface UpdateInput {
  readonly installed: string;
  readonly latest: string | null;
  readonly state: ReleaseState;
  /** Where this CLI is installed — `installRoot()`, not the workspace. */
  readonly root: string;
  /** Where Bun keeps global installs, so a copy landing elsewhere is visible. */
  readonly bunGlobal: string;
}

/**
 * The whole decision, as a function of five strings.
 *
 * Split from the spawn because the alternative is a command whose only test is
 * one that replaces the copy of this CLI on the machine running the suite. Every
 * branch below is reachable from `update.test.ts` with no network and no
 * subprocess — including the stale branch, which the checkout this is written in
 * can never reach on its own, being by definition the newest thing there is.
 */
export function updatePlan(input: UpdateInput): UpdateDecision {
  const { installed, latest, state, root, bunGlobal } = input;

  // A published install lives under `node_modules`; a checkout does not. Cheaper
  // and steadier than looking for `.git`, which a tarball could carry and a
  // shallow export could lack.
  const published = root.split(sep).includes('node_modules');

  if (!published) {
    return {
      action: 'checkout',
      install: null,
      message: `${root} is a checkout, not an install — git pull is the update here`,
      warning: null,
    };
  }

  if (state === 'unknown') {
    return {
      action: 'unknown',
      install: null,
      message:
        latest === null
          ? `could not reach the registry — ${installed} is installed`
          : `cannot compare ${installed} against ${latest}`,
      warning: null,
    };
  }

  if (state === 'ahead') {
    return {
      action: 'ahead',
      install: null,
      message: `${installed} is installed, ahead of the published ${latest ?? 'release'}`,
      warning: null,
    };
  }

  if (state === 'current') {
    return { action: 'current', install: null, message: `${installed} is current`, warning: null };
  }

  // Installed by npm, updated by Bun: `bun install -g` writes into its own
  // global prefix and leaves the npm copy where it is, so both are on the PATH
  // and its order decides which one answers. Worth saying before, not after.
  const elsewhere = !root.startsWith(bunGlobal + sep);

  return {
    action: 'install',
    install: ['install', '-g', PACKAGE],
    message: `${installed} installed, ${latest} available`,
    warning: elsewhere
      ? `this copy is at ${root}, which is not under ${bunGlobal} — ` +
        'Bun will install a second copy there rather than replace this one, ' +
        'and your PATH order decides which one answers'
      : null,
  };
}

/** Where Bun keeps global installs, honouring `BUN_INSTALL`. */
export function bunGlobalRoot(env: Record<string, string | undefined> = process.env): string {
  return join(env['BUN_INSTALL'] ?? join(homedir(), '.bun'), 'install', 'global');
}

export async function update(flags: UpdateFlags): Promise<void> {
  const current = await release();
  const root = installRoot(import.meta.dir);
  const decision = updatePlan({
    installed: current.installed,
    latest: current.latest,
    state: current.state,
    root,
    bunGlobal: bunGlobalRoot(),
  });

  // A gate wants a non-zero exit for the one state that needs action. An
  // unreachable registry is not that state — failing a build because a network
  // was down would make this the flakiest check in it.
  if (flags.check === true && decision.action === 'install') process.exitCode = 1;

  // Whatever the registry said, and before the branch that returns early.
  //
  // `start`, `connect` and `deploy` already repair a profile that is missing
  // part of the owner layer, and for months that was enough. It is not: a
  // release that adds a surface — `tasks` and `assets` in 0.5.0 — leaves every
  // existing profile without it until one of those three next runs, and someone
  // who serves their endpoint from elsewhere may run none of them for weeks. The
  // page they look at meanwhile offers to *add* what they already have,
  // which is where this was reported from.
  //
  // `update` is the command that means "bring me current", so it is the honest
  // place for the other half of current. Not on `--check`, which is a question
  // and must not write, and not conditional on an install having happened: the
  // profile of someone already on the latest version is exactly the one this was
  // reported against.
  if (flags.check !== true) {
    const root = resolveWorkspaceRoot();

    // The contract migration before the owner-layer repair, and the order is not
    // cosmetic: the repair opens profiles through the ordinary loader, and the
    // loader refuses contract 1 outright (ADR-052). On a workspace that has not
    // been migrated the repair has nothing it can read.
    //
    // Local workspace only. A remote one is a bucket whose endpoint is running a
    // pinned image, and migrating it from here would leave that revision reading
    // a contract it does not implement until someone redeploys. `deploy` is what
    // migrates a bucket, because it is the command that ships the image in the
    // same breath.
    const migrated = await migrateLocal(root, flags.json === true ? progress : print);

    // Only on a workspace that is actually at the current contract — see
    // `migrateLocal`. The repair writes contract-3 shapes, and writing them
    // after a refusal that said nothing had been written is what left a stray
    // `connections.yaml` in a contract-2 workspace.
    if (migrated) {
      await repairOwnerLayer(root, undefined, {
        ...(flags.json === true ? { report: progress } : {}),
      });
    }
  }

  const report = {
    installed: current.installed,
    latest: current.latest,
    state: current.state,
    action: decision.action,
    root,
    ...(decision.install !== null ? { install: `bun ${decision.install.join(' ')}` } : {}),
    ...(decision.warning !== null ? { warning: decision.warning } : {}),
  };

  if (flags.check === true || decision.action !== 'install') {
    return emit(flags.json, report, () => {
      if (decision.action === 'install') {
        print(warn(decision.message));
        if (decision.warning !== null) print(style.dim(`      ${decision.warning}`));
        print(style.dim('      run: lanes link update'));
        return;
      }

      // Green for the two states that need nothing. A refusal and an
      // unreachable registry are neither wrong nor fine, and `ok` would claim
      // the second of those.
      if (decision.action === 'current' || decision.action === 'ahead') {
        print(ok(decision.message));
        return;
      }

      print(style.dim(decision.message));
    });
  }

  // Stderr, both of them. What this command produces is the version change, and
  // with `--json` that is a document — a line of prose in front of it corrupts
  // it for whatever is parsing, which is the whole reason `emit` exists.
  if (decision.warning !== null) progress(warn(decision.warning));
  progress(style.dim(`bun ${decision.install!.join(' ')}`));

  const installed = await runInstall(decision.install!, flags.json === true);
  if (!installed) {
    printErr(fail('the install did not complete — nothing was changed'));
    process.exitCode = 1;
    return;
  }

  // Read the version back off disk rather than trusting the exit code. `version()`
  // reads `package.json` from the install root at call time, so this is the one
  // question worth asking after a successful install: did *this* copy change?
  // Unchanged after a clean install is the second-copy case above, seen from the
  // other side.
  const landed = version();

  return emit(
    flags.json,
    {
      ...report,
      // The action was `install`; this is what came of it. Inventing a third
      // action value would describe an outcome as a decision.
      result: landed === current.installed ? 'unchanged' : 'installed',
      installed: landed,
      previous: current.installed,
    },
    () => {
      if (landed === current.installed) {
        print(warn(`bun reported success, but ${root} is still ${landed}`));
        print(style.dim('      the copy it installed is somewhere else on your PATH'));
        print(style.dim('      check with: which -a lanes'));
        return;
      }

      print(ok(`${current.installed} → ${style.bold(landed)}`));
      print(style.dim('      a running endpoint serves the old code until it is restarted'));
    },
  );
}

/**
 * Hand the install to Bun and let it own the terminal.
 *
 * `process.execPath` rather than `Bun.which('bun')`: this process is already
 * running under the Bun that should do the installing, and a PATH lookup can
 * find a different one — which would resolve the dependency set with a
 * different resolver than the one that will run the result.
 *
 * Output is inherited rather than captured. Bun prints its own progress and its
 * own errors, and paraphrasing a package manager's failure is how a report ends
 * up less useful than the thing it replaced. Its stdout is dropped under
 * `--json` for the same reason the lines above go to stderr: the document on
 * stdout has to be the only thing on stdout. Its stderr is kept either way,
 * because a failure is worth reading in both modes.
 */
async function runInstall(argv: readonly string[], json: boolean): Promise<boolean> {
  try {
    const child = Bun.spawn([process.execPath, ...argv], {
      stdout: json ? 'ignore' : 'inherit',
      stderr: 'inherit',
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Bring the local workspace to the current contract, saying so if it did.
 *
 * Narrated rather than silent: this rewrites every profile in the workspace, and
 * a command that reshapes somebody's config without a word is one they cannot
 * audit afterwards. Routed to `report` for `--json`, where a line of prose in
 * front of the document corrupts whatever is parsing it — the same routing
 * `repairOwnerLayer` takes, for the same reason.
 *
 * A failure here is reported and swallowed. `update`'s job is to install a
 * version, and a workspace that cannot migrate — a custom path that will not
 * hoist, two profiles disagreeing about one target — is a thing to be told
 * about, in a sentence naming the fix, rather than a reason for the upgrade to
 * fail. `check` and `doctor` both refuse loudly on the next run.
 */
/**
 * Contract 2 to contract 3, reported the same way its predecessor is.
 *
 * Loud about what moved, because this one moves credentials. An operator whose
 * fifteen accounts were merged into one store should see that happen rather than
 * discover it from a directory listing.
 */
function sayContract3(migration: Contract3Migration, say: (line: string) => void): void {
  say(
    `migrated ${migration.profiles.length} profile(s) to contract 3 — connections belong to the ` +
      'workspace now, and a profile grants them one by one',
  );
  for (const change of migration.changes) say(`  ${change}`);

  if (migration.renames.length > 0) {
    say('  Two profiles named different accounts with the same id, so one was renamed.');
    say('  Check the grants in each profile before running an agent against them.');
  }

  say(`  The old per-profile credential stores are left in place; remove them once this works.`);
}

async function migrateLocal(root: string, say: (line: string) => void): Promise<boolean> {
  try {
    // One call, both steps, in order — a workspace that predates both walks
    // through them rather than jumping, so each step's reasoning applies to the
    // shape it was written for. `update` used to spell that walk itself, which
    // is how `deploy` and `doctor --fix` came to spell only half of it.
    //
    // The subject is passed rather than left to be defaulted because this is
    // the one caller that already had it in hand.
    const session = await readSession();
    const migration = await migrateToCurrentContract(root, {
      apply: true,
      ...(session ? { subject: session.subject } : {}),
    });

    if (migration.legacy) sayLegacyTargets(migration.legacy, say);
    if (migration.contract3) sayContract3(migration.contract3, say);
    return true;
  } catch (error) {
    say(`could not migrate this workspace: ${error instanceof Error ? error.message : String(error)}`);

    // **Still behind, not "something threw".** Keying the repair on the throw
    // suppressed it for the whole workspace when one profile failed to
    // migrate — so the others, already current, never received a newly shipped
    // surface, which is the case `update` runs the repair for at all. One
    // unreadable profile is a per-profile warning, which the repair already
    // gives it.
    const behind = await stillBehind(root);
    if (behind) say('  the owner-layer repair is skipped until it does');
    return !behind;
  }
}

/** Anything still below the current contract. Unreadable counts as behind. */
function stillBehind(root: string): Promise<boolean> {
  return needsMigration(root)
    .then(async (one) => one || (await needsContract3(root)) || (await needsContract4(root)))
    .catch(() => true);
}

/** Contract 1 to contract 2: targets move from the profile to the workspace. */
function sayLegacyTargets(
  migration: NonNullable<ContractMigration['legacy']>,
  say: (line: string) => void,
): void {
  say(
    `migrated ${migration.profiles.length} profile(s) to contract 2 — a target is declared by ` +
      'the workspace now, not by each profile',
  );
  for (const change of migration.changes) say(`  ${change}`);

  for (const pointer of migration.targets.filter((one) => one.kind === 'pointer')) {
    say(
      `  "${pointer.name}" points at ${pointer.where} — run ` +
        `lanes link deploy --workspace ${pointer.name} to migrate what is there`,
    );
  }
}

