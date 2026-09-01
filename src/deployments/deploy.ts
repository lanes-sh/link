import {
  ConfigError,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
  type DeployConfig,
} from '#profile';
import { announce, fail, heading, ok, print, style, warn } from '#cli/output.ts';
import { staleNudge } from '#cli/release.ts';
import { version } from '#cli/version.ts';
import { confirm, isInteractive } from '#cli/prompt.ts';
import { openSecretStoreFor, resolveProfile, type GlobalFlags } from '#cli/runtime.ts';
import { resolveTarget, vaultEnv } from './bootstrap.ts';
import { recordDeployment, type DeploymentRecord } from './record.ts';
import { printSteps, runSteps } from './steps.ts';
import { driverFor } from './drivers.ts';
import { prepareSecrets, readableRefs, rotatableRefs } from './prepare.ts';
import { repairOwnerLayer } from '#cli/config-repair.ts';
import { migrateToCurrentContract } from '#cli/workspace-migrate.ts';
import { deployedWorkspace, uploadWorkspace } from './upload.ts';
import { servingProfiles } from './serving.ts';
import { healthLine, reachability, registerLine, reportUnauthorised } from './report.ts';

/**
 * `lanes link deploy` — set up what is missing, build the image, roll a revision,
 * print the URL.
 *
 * A thin wrapper, deliberately. `docs/detailed/init.md` is explicit that this must not
 * grow plan-and-apply state files, deploy leases, drift reconciliation, or a
 * rollback manifest: revisions already are the rollback, and that machinery
 * belongs to a multi-target org deployment tool rather than to a single-user
 * instance. What is here is the ordered list of things that have to happen, the
 * questions whose answers it cannot derive, and refusals early enough to be
 * cheap.
 *
 * It knows no vendor. Which platform a target deploys to is a field in its
 * config, and everything vendor-shaped behind `driverFor`.
 */

export interface DeployFlags extends GlobalFlags {
  /** Print the commands and the checks without running any of them. */
  readonly dryRun?: boolean | undefined;
  /** Override the declared `access` for this run. */
  readonly access?: string | undefined;
  readonly serviceAccount?: string | undefined;
  readonly tag?: string | undefined;
  /** Skip the confirm before creating cloud resources. */
  readonly yes?: boolean | undefined;
  /**
   * Never prompt: take the setup answers from the config and assume the confirm.
   *
   * Implied when stdin is not a terminal, so a scripted deploy needs no flag —
   * this is for a terminal attached to a job nobody is watching.
   */
  readonly nonInteractive?: boolean | undefined;
  /**
   * Which profiles to send, narrowing the set the target implies.
   *
   * Repeatable, and absent means every profile declaring the target — the set
   * the endpoint is going to open either way (ADR-043). The first one named is
   * the primary.
   */
  readonly profiles?: readonly string[] | undefined;
}

export async function deploy(flags: DeployFlags): Promise<void> {
  // **The target's own workspace is migrated before anything resolves it.**
  //
  // This is the first thing the command does, and it has to be. `deploy` is what
  // the refusal on a contract-1 bucket tells you to run — and every other read of
  // that bucket goes through `openTarget`, which refuses it for the same reason.
  // Migrating after resolution made the instruction circular: the command named
  // as the fix could not get past the problem it fixes.
  //
  // `resolveTargetWorkspace` is the one lookup that does not need the far end to
  // declare anything: it reads this machine's pointer and stops. So the bucket is
  // located, migrated, and only then opened.
  //
  // Idempotent, and silent on a workspace already current — a listing and no
  // writes. `--dry-run` reports what it would do and writes nothing, like every
  // other step of this command.
  //
  // It goes all the way to `SUPPORTED_CONTRACT`, which it did not use to: this
  // ran the contract 1→2 step alone, so a contract-2 bucket passed straight
  // through and the revision came up reading an empty `data/` while the bytes
  // stayed under `data/<profile>/`. See `migrateToCurrentContract`.
  if (!(await migrateTargetWorkspace(requireTargetFlag(flags), flags.dryRun !== true))) return;

  // The one command allowed to name a target that does not exist yet: creating
  // it is what a first deploy is for.
  //
  // It used to work out its own target too — the one declaring a `deploy` block,
  // guessing when there was one, refusing when there were two, and inventing
  // `cloud` when there were none. That inference was a defence against
  // `instance.default_target`, which is `local` on a scaffolded profile and
  // never the answer to "deploy what". With the fallback gone (ADR-037) the
  // defence has nothing to defend against, and what is left is three behaviours
  // from one command line on the command that creates cloud resources and rolls
  // a public URL — where `allowUndeclaredTarget` means a mistake is not refused
  // but surveyed, written into the profile, and deployed as a new service.
  //
  // Which profiles is derived rather than named: every profile declaring the
  // target, because that is the set the revision will try to open (ADR-009).
  // `--profile` narrows it, and a first deploy still has to name one — a target
  // nothing declares has no set to derive from.
  const { profiles: serving, primary } = await servingProfiles({
    workspaceRoot: resolveWorkspaceRoot(),
    target: requireTargetFlag(flags),
    named: flags.profiles ?? [],
  });

  const { resolution, config, target } = await resolveProfile(
    { ...flags, profile: primary },
    { allowUndeclaredTarget: true },
  );
  announce(resolution);
  if (serving.length > 1) {
    print(style.dim(`         serving ${serving.join(', ')} — ${primary} owns the token`));
  }

  // The credential-collision preflight is gone. It existed because two profiles
  // each held their own `gmail.main` and both derived the flat ref `gmail/main`
  // into one store — the last deploy winning, with no later symptom worth
  // having. A connection belongs to the workspace now and `<provider>.<id>` is
  // unique by construction (ADR-057), so the state it guarded against cannot be
  // written: `assertConnectionsUnique` refuses it at load, before a deploy runs
  // at all.

  // `check` before anything external, per the gate order: a config that will be
  // rejected on boot should be rejected here, not after a five-minute build.
  print(ok(`${resolution.profilePath} is valid`));

  // The CLI planning this rollout, not the image it will build. An old one
  // plans an old rollout, and a build is the most expensive place to find that
  // out.
  const stale = await staleNudge();
  if (stale !== null) print(warn(stale));

  const declared = await resolveTarget({
    config,
    profilePath: resolution.profilePath,
    workspaceRoot: resolution.workspaceRoot,
    profile: resolution.profile,
    target,
    flags,
  });

  const deployConfig = declared.deploy!;
  const driver = await driverFor(deployConfig.platform);

  const tag = flags.tag ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  // Which credentials the revision will rewrite, so the steps below can grant
  // each one. Scoped by `flags.profile` exactly as the upload and the repair
  // below are, and read from config and manifests before anything opens a
  // store — `--dry-run` must reach the printed step list without touching a
  // credential.
  const rotatable = await rotatableRefs(resolution.workspaceRoot, serving, declared);
  const readable = await readableRefs(resolution.workspaceRoot, serving, declared);
  const provision = await driver.provision({
    deploy: deployConfig,
    declared,
    target,
    rotatable,
    readable,
    profiles: serving,
  });

  // Where the running instance will read its config. The bucket the target
  // already declares for everything else — the workspace is not baked into the
  // image any more (ADR-023), so this has to be passed at rollout.
  const workspace = deployedWorkspace(declared);
  const secretEnv = vaultEnv(declared);

  const rollout = driver.plan({
    deploy: deployConfig,
    tag,
    target,
    profile: resolution.profile,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(secretEnv ? { secretEnv } : {}),
  });

  heading(
    `Deploying ${style.bold(deployConfig.service)} to ${deployConfig.region}` +
      (deployConfig.project ? ` (${deployConfig.project})` : ''),
  );
  print(style.dim(`  platform: ${deployConfig.platform}`));
  print(reachability(deployConfig.access));

  if (flags.dryRun) {
    printSteps(driver, [...provision, ...rollout]);
    print('');
    if (workspace) print(style.dim(`  the workspace would be uploaded to ${workspace}`));
    // Not "nothing was run": planning the list above reads the IAM policies this
    // deploy would change, because what it supersedes is a fact about what is
    // there. Reads only, and no credential among them.
    print(style.dim('  --dry-run: nothing was changed, and no credential was read or written.'));
    return;
  }

  const missing = driver.preflight();
  if (missing) throw new ConfigError(missing);

  // First, and before anything reaches for what they create.
  //
  // These used to run after the credential check and the workspace upload,
  // which meant a genuinely first deploy asked Secret Manager for a token in a
  // project where that API was not enabled yet, and wrote config into a bucket
  // that did not exist — failing, both times, several steps before the step
  // that would have fixed it. The ordering was invisible because the second
  // deploy onwards finds everything present and works.
  if (provision.length > 0) {
    heading(`First-run setup (${provision.length} steps)`);
    printSteps(driver, provision);
    print('');
    print(
      style.dim(
        '  Each of these already existing is the expected case on every deploy after\n' +
          '  the first, and is not treated as a failure.',
      ),
    );
    // `--non-interactive` assumes it: a confirm nobody can answer is a hang, and
    // the same run already took its setup answers from the config rather than
    // asking. `--yes` remains the way to skip it with a terminal attached.
    const assumed = flags.yes === true || flags.nonInteractive === true || !isInteractive();
    if (!assumed && !(await confirm('  Create these now?'))) {
      throw new ConfigError('Stopped before creating anything. Nothing was changed.');
    }
    await runSteps(driver, provision);
  }

  const credentials = await openSecretStoreFor(config, resolution.workspaceRoot, target);
  const prepared = await prepareSecrets({
    config,
    declared,
    credentials,
    root: resolution.workspaceRoot,
    target,
    readOnly: false,
  });

  if (prepared.blocking.length > 0) {
    heading('Still missing');
    for (const problem of prepared.blocking) print(fail(problem));
    throw new ConfigError(
      'The deployed instance cannot start without these. Store them with ' +
        `lanes link secrets set <ref> --profile ${resolution.profile} --workspace ${target}, or ` +
        `copy a local setup with lanes link secrets push --profile ${resolution.profile} ` +
        `--from local --to ${target}.`,
    );
  }

  // Repair the local config before it is copied up, not the copy in the bucket.
  //
  // The bucket copy is the wrong end: config flows one way, local CLI to remote
  // instance (ADR-023), and the deployed revision holds `objectViewer` on
  // `profiles/` so it cannot write there anyway. Fixing the local file keeps
  // the two agreeing, which is the property that makes the one-way flow safe.
  //
  // This is also the only place the gap gets noticed. `doctor` reports a
  // profile with no `setup` connection, but the operator of a deployed endpoint
  // has no reason to run it — and the symptom appears in a chat client, days
  // later, as an agent guessing at a command that does not exist.
  // Behind the same guard as the upload, and reading the same scope.
  //
  // The guard because a target with no bucket uploads nothing: repairing for it
  // would rewrite the operator's config as a side effect of a command that
  // copied their config nowhere. The shared scope because a profile that gets
  // uploaded is a profile that gets served, and repairing a narrower set than
  // the upload sends would leave a served profile without the surface — this
  // bug again, one profile over.
  let recorded: DeploymentRecord | null = null;
  if (workspace) {
    // The pre-flight that used to sit here is gone with contract 1. It refused
    // a deploy carrying a profile that did not declare the target, because the
    // endpoint opens every profile in the bucket against one target and one
    // that could not run on it took the whole revision down. A profile declares
    // no target now (ADR-052) — it lives in one — so there is no profile in this
    // workspace that this target cannot open, and nothing left to check.
    await repairOwnerLayer(resolution.workspaceRoot, serving);

    // **The bucket's own contract, before anything is written over it.**
    //
    // The pass at the top of the command resolves the target through this
    // machine's pointer, which a *first* deploy does not have: the entry is
    // still a declaration, `resolveTargetWorkspace` answers with the local root,
    // and it returns early. So this is the only pass that ever sees an existing
    // bucket at contract 2 — and running it after the upload is the same as not
    // running it, because the upload writes contract-3 profiles and
    // `needsContract3` reads the profiles.
    await migrateToCurrentContract(workspace, { apply: true });

    // Before the rollout, so the revision that comes up finds a config to read.
    // Uploading after would leave a window where the service is serving and the
    // workspace it was told to read is not there yet.
    // **Only when there is somewhere to copy from.** After ADR-052 the profiles
    // a deployed target serves *live in* that target's workspace, so
    // `resolution.workspaceRoot` and `workspace` are the same bucket and this is
    // a copy onto itself. It ran, and the self-copy is how the bucket's registry
    // came to be overwritten.
    //
    // What it is still for is the one-way trip: a first deploy, where the
    // profile is on this machine and the bucket does not hold it yet. That is a
    // move, not a sync — the next deploy finds it already there.
    if (resolution.workspaceRoot !== workspace) {
      await uploadWorkspace(resolution.workspaceRoot, workspace, serving);
    }

    // Again for what the upload put there: a newly created bucket gets its
    // profiles written here for the first time. Idempotent — one listing.
    await migrateToCurrentContract(workspace, { apply: true });

    // Where this deployment lives, in both registries — see `record.ts`. The
    // declaration has to land before the revision boots, so it goes here rather
    // than after the rollout; what rolled it is written once it has.
    recorded = {
      workspace,
      target,
      declared,
      primary: resolution.profile,
      at: new Date().toISOString(),
    };
    await recordDeployment(recorded);
  }

  heading('Rolling out');
  await runSteps(driver, rollout);

  // The release that rolled it, now that it has. `version()` is read from the
  // installed package, which is the same tree the image was built from.
  if (recorded) await recordDeployment({ ...recorded, version: version() });

  const url = await driver.url(deployConfig);
  if (!url) {
    print(
      warn(
        `deployed, but the platform reported no URL yet — run: lanes link outputs --profile ${resolution.profile} --workspace ${target}`,
      ),
    );
    return;
  }

  heading('Endpoint');
  print(`  ${url}/mcp`);
  print(await healthLine(url));
  print('');
  print(registerLine(resolution.profile, target));

  reportUnauthorised(prepared.warnings, resolution.profile, target);
}

/** `--target` is required by `SELECTION`; this is the type narrowing, not a check. */
function requireTargetFlag(flags: DeployFlags): string {
  if (!flags.target) {
    throw new ConfigError('--target is required. It names the deployment this acts on.');
  }
  return flags.target;
}

/**
 * Bring a target's own workspace to the current contract, before it is opened.
 *
 * Deliberately tolerant of a target this workspace has no pointer for: that is a
 * first deploy, where there is nothing to migrate and `deploy` is about to create
 * the workspace itself.
 *
 * Narrated when it does something. This rewrites every profile in somebody's
 * bucket, and a command that reshapes that silently is one they cannot audit
 * afterwards.
 */
async function migrateTargetWorkspace(target: string, apply: boolean): Promise<boolean> {
  const root = resolveWorkspaceRoot();

  const workspace = await resolveTargetWorkspace(root, target).catch(() => null);
  if (workspace === null || workspace === root) return true;

  const migrated = await migrateToCurrentContract(workspace, { apply });
  if (migrated.alreadyCurrent) return true;

  heading(apply ? 'Migrated' : 'Would migrate');
  print(style.dim(`  ${workspace}`));
  for (const change of migrated.changes) print(`  ${change}`);
  if (apply) {
    print(style.dim('  The revision this deploy rolls is the first that can read it.'));
    return true;
  }

  // A dry run stops here rather than pressing on to survey and plan. Everything
  // past this point opens the target, and the target is not readable until the
  // migration above has actually happened — so continuing would report a second,
  // confusing refusal about the thing the first paragraph just offered to fix.
  print(style.dim('  Nothing was written, and nothing else was checked: the rest of this'));
  print(style.dim('  command opens the target, which is not readable until this has run.'));
  print('');
  print(style.dim(`  Run it for real:  lanes link deploy --workspace ${target}`));
  return false;
}
