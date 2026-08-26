import { ConfigError, recordDeployment, resolveWorkspaceRoot, type DeployConfig } from '#profile';
import { announce, fail, heading, ok, print, style, warn } from '#cli/output.ts';
import { staleNudge } from '#cli/release.ts';
import { confirm, isInteractive } from '#cli/prompt.ts';
import { openSecretStoreFor, resolveProfile, type GlobalFlags } from '#cli/runtime.ts';
import { resolveTarget, vaultEnv } from './bootstrap.ts';
import { printSteps, runSteps } from './steps.ts';
import { driverFor } from './drivers.ts';
import { prepareSecrets, readableRefs, rotatableRefs } from './prepare.ts';
import { deployedWorkspace, repairSetupSurface, uploadWorkspace } from './upload.ts';
import { unservableProfiles, unservableRefusal } from './servable.ts';
import { collidingRefs, collisionRefusal, servingProfiles } from './serving.ts';
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
   * the endpoint is going to open either way (ADR-040). The first one named is
   * the primary.
   */
  readonly profiles?: readonly string[] | undefined;
}

export async function deploy(flags: DeployFlags): Promise<void> {
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

  // Before anything external, beside `check`, and for the same reason: two
  // profiles writing one flat credential ref into one store is a failure with
  // no later symptom worth having.
  const colliding = await collidingRefs(resolution.workspaceRoot, serving);
  if (colliding.length > 0) {
    heading('Cannot share a credential store');
    throw new ConfigError(collisionRefusal(colliding, target));
  }

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
  const rotatable = await rotatableRefs(resolution.workspaceRoot, serving);
  const readable = await readableRefs(resolution.workspaceRoot, serving, declared);
  const provision = await driver.provision({
    deploy: deployConfig,
    declared,
    target,
    rotatable,
    readable,
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
    print(style.dim('  --dry-run: nothing was run, and no credential was read or written.'));
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
        `lanes link secrets set <ref> --profile ${resolution.profile} --target ${target}, or ` +
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
  if (workspace) {
    // Before anything is copied, and before the rollout: the endpoint opens
    // every profile in the bucket against this one target, so a profile that
    // does not declare it is not a profile that gets skipped — it is a revision
    // that never goes healthy. `servable.ts` has the whole failure.
    //
    // Here rather than at the top of the command because it reads the same
    // scope the upload does, and that scope is not settled until `workspace`
    // says there is a bucket to send to at all.
    const unservable = await unservableProfiles({
      workspaceRoot: resolution.workspaceRoot,
      profiles: serving,
      target,
    });

    if (unservable.length > 0) {
      heading('Cannot be served');
      throw new ConfigError(unservableRefusal(unservable, target));
    }

    await repairSetupSurface(resolution.workspaceRoot, serving);

    // Before the rollout, so the revision that comes up finds a config to read.
    // Uploading after would leave a window where the service is serving and the
    // workspace it was told to read is not there yet.
    await uploadWorkspace(resolution.workspaceRoot, workspace, serving);

    // Recorded once the bucket is known to hold this target's config. It is an
    // index, not configuration (ADR-041) — the next recovery reads it instead
    // of asking the platform.
    await recordDeployment(resolution.workspaceRoot, {
      target,
      workspace,
      primary: resolution.profile,
      last_deploy: new Date().toISOString(),
    });
  }

  heading('Rolling out');
  await runSteps(driver, rollout);

  const url = await driver.url(deployConfig);
  if (!url) {
    print(
      warn(
        `deployed, but the platform reported no URL yet — run: lanes link outputs --profile ${resolution.profile} --target ${target}`,
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
