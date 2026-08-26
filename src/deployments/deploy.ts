import { ConfigError, TARGET_ENV, resolveDeployTarget, type DeployConfig } from '#profile';
import { announce, fail, heading, ok, print, style, warn } from '#cli/output.ts';
import { staleNudge } from '#cli/release.ts';
import { confirm, isInteractive } from '#cli/prompt.ts';
import { openSecretStoreFor, resolveProfile, type GlobalFlags } from '#cli/runtime.ts';
import { resolveTarget, vaultEnv } from './bootstrap.ts';
import { printSteps, runSteps } from './steps.ts';
import { driverFor } from './drivers.ts';
import { prepareSecrets, readableRefs, rotatableRefs } from './prepare.ts';
import { deployedWorkspace, repairSetupSurface, uploadWorkspace } from './upload.ts';
import { defaultTargetHandOff } from './handoff.ts';
import { unservableProfiles, unservableRefusal } from './servable.ts';

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
}

export async function deploy(flags: DeployFlags): Promise<void> {
  // The one command allowed to name a target that does not exist yet: creating
  // it is what a first deploy is for.
  const { resolution, config } = await resolveProfile(flags, { allowUndeclaredTarget: true });

  // And the one command that can work out which target it meant. `resolveProfile`
  // falls back to `instance.default_target`, which is the target commands *run*
  // against — `local`, and never the answer to "deploy what".
  const { target, source } = resolveDeployTarget(config, flags.target);
  announce({ ...resolution, target, targetSource: source });

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
  const rotatable = await rotatableRefs(resolution.workspaceRoot, flags.profile);
  const readable = await readableRefs(resolution.workspaceRoot, flags.profile, declared);
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
    ...(flags.profile !== undefined ? { profile: flags.profile } : {}),
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
        `lanes link secrets set <ref> --target ${target}, or copy a local setup with ` +
        `lanes link secrets push --from local --to ${target}.`,
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
      profile: flags.profile,
      target,
    });

    if (unservable.length > 0) {
      heading('Cannot be served');
      throw new ConfigError(unservableRefusal(unservable, target));
    }

    await repairSetupSurface(resolution.workspaceRoot, flags.profile);

    // Before the rollout, so the revision that comes up finds a config to read.
    // Uploading after would leave a window where the service is serving and the
    // workspace it was told to read is not there yet.
    await uploadWorkspace(resolution.workspaceRoot, workspace, flags.profile);
  }

  heading('Rolling out');
  await runSteps(driver, rollout);

  const url = await driver.url(deployConfig);
  if (!url) {
    print(
      warn(
        `deployed, but the platform reported no URL yet — run: lanes link outputs --target ${target}`,
      ),
    );
  } else {
    heading('Endpoint');
    print(`  ${url}/mcp`);
    print(await healthLine(url));
    print('');
    print(registerLine(target));

    reportUnauthorised(prepared.warnings, target);
  }

  // Last, and on the no-URL path too — that deploy still succeeded, and where
  // the operator's next command runs is just as wrong either way. It goes after
  // `reportUnauthorised` for the reason that function's own comment gives about
  // going last: this one governs every subsequent command, so it has the
  // strongest claim on the bottom of the screen. On a first deploy nothing is
  // unauthorised yet and this is the only thing left on it.
  const handOff = defaultTargetHandOff({
    deployed: target,
    defaultTarget: config.instance.default_target,
    ...(process.env[TARGET_ENV] ? { fromEnv: process.env[TARGET_ENV] } : {}),
  });
  if (handOff) {
    print('');
    print(handOff);
  }
}

/**
 * How to register the endpoint, and when.
 *
 * The ordering is the whole point of the second half. A client captures
 * `tools/list` when it connects and keeps it: this endpoint is stateless, so
 * there is no stream on which to send `notifications/tools/list_changed`, and
 * `buildMcpServer` no longer pretends otherwise. A first deploy necessarily
 * publishes a profile whose only connection is `setup.main` — the accounts come
 * after — so a connector registered in that window captures a two-tool surface
 * and holds it. The endpoint is right, every reload lands, and the client shows
 * two tools until someone removes and re-adds it.
 *
 * Unconditional, and that is the correction that matters. This was gated on
 * `prepared.warnings.length`, which is zero in precisely the case it describes:
 * a fresh profile declares only `setup.main`, `setup` is a local provider with
 * no credential, so `prepareSecrets` has nothing to warn about. The advice
 * appeared only on a later re-deploy, by which point the connector is usually
 * registered and the ordering is no longer available to get right.
 */
function registerLine(target: string): string {
  return style.dim(
    `  Connect your accounts first, then register with: lanes link outputs --target ${target}\n` +
      '  A client keeps the tool list it fetched when it connected, so one registered\n' +
      '  before the accounts holds a surface without them until it is re-added.',
  );
}

/**
 * The accounts a browser still has to authorise, and the step after them.
 *
 * Printed last rather than before the build, because this is the only thing
 * left to do and a list eight steps up the scrollback is a list nobody reads.
 *
 * There is no second deploy at the end of it any more, and the reason the old
 * one existed is worth keeping. Connection *credentials* are read live on every
 * call, so a fresh `connect` looked like it should be picked up — but whether a
 * connection was usable at all was decided by a reconcile that ran once per
 * process, so a revision that came up with an account unauthorised went on
 * refusing it, naming the connection rather than the staleness. Reconcile now
 * runs again on every reload, and `connect` asks for one (ADR-029).
 */
function reportUnauthorised(warnings: readonly string[], target: string): void {
  if (warnings.length === 0) return;

  heading('Not authorised yet');
  for (const problem of warnings) print(warn(problem));
  print('');
  print(
    style.dim(
      '  A browser consent per account is the one step this cannot take for you:\n' +
        `    lanes link connect <provider> --target ${target}\n` +
        '  Each is served as soon as it is authorised. There is no second deploy —\n' +
        '  deploying is how code gets here, and authorising an account changes none.',
    ),
  );
}

/**
 * Who can reach the service once this lands.
 *
 * Printed on every deploy rather than only when it changes, because it is the
 * one property of a deployment that is invisible from the outside until someone
 * either cannot get in or should not have been able to.
 */
function reachability(access: DeployConfig['access']): string {
  return access === 'iam'
    ? style.dim(
        '  access:   iam — the platform admits only callers holding its own identity\n' +
          '            token. No agent harness can mint one; use --access public with an\n' +
          '            authorization block if a remote MCP client has to reach this.',
      )
    : style.dim(
        '  access:   public — the platform lets requests through and this endpoint\n' +
          '            authenticates them. The bearer token is what protects it.',
      );
}

/** Ask the deployed endpoint whether it came up. */
async function healthLine(url: string): Promise<string> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return warn(`the endpoint answered /health with ${response.status}`);

    // Asked anonymously, so it reports that the revision is up and nothing
    // about what it serves — the profile list is behind the token now.
    // `lanes link outputs` holds one and prints the rest.
    const body = (await response.json()) as { profiles?: string[] };
    return ok(
      body.profiles
        ? `healthy — serving ${body.profiles.join(', ')}`
        : 'healthy — run `lanes link outputs` for what it serves',
    );
  } catch {
    // A cold start plus a database connect can outrun a short probe, and
    // `access: iam` makes /health unreachable from here by design. Neither is a
    // failed deploy.
    return warn('could not reach /health from here — with access: iam that is expected');
  }
}
