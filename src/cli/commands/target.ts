import {
  TARGET_ENV,
  askedTarget,
  loadProfileConfig,
  resolveSelection,
  undeclaredTarget,
  type Config,
  type Resolution,
} from '#profile';
import { deployedUrl, deploymentIdentity, type DeploymentIdentity } from '../endpoint-url.ts';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, heading, ok, print, style, table, waiting, warn } from '../output.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link target` — the adapter sets a profile declares, and which one is in play.
 *
 * A target names *where a profile runs*: a credential store and a blob store,
 * and optionally a deployment. Connections, providers, policy and limits are
 * declared once and apply to every target, so changing one changes where the
 * bytes go and nothing above them.
 *
 * Two answers are worth telling apart and this is the only place that does.
 * `instance.default_target` is what commands run against when nobody says, and
 * it lives in the profile. `LANES_LINK_TARGET` is what *this shell* says, and it
 * wins. When they disagree — the case that sends someone hunting a bug — `list`
 * marks both and names the variable.
 *
 * Each command is a data function plus a printing wrapper, the split
 * `profile.ts` uses and for the same reason: `--json` wants the facts without
 * the rendering.
 */

export interface TargetSummary {
  readonly name: string;
  /** `instance.default_target` — what the file says. */
  readonly isDefault: boolean;
  /** What this shell resolves to right now, which may not be the above. */
  readonly isSelected: boolean;
  readonly credentials: string;
  readonly storage: string;
  readonly vault: string;
  /** Whether a deployment is declared. Free, and always present. */
  readonly deployed: boolean;
  readonly deployment: DeploymentIdentity | null;
  /** Only when asked for; absent is "not asked", null is "asked, no answer". */
  readonly url?: string | null;
}

export interface TargetListing {
  readonly root: string;
  readonly profile: string;
  readonly path: string;
  readonly default: string;
  readonly selected: string;
  readonly selectedSource: 'flag' | 'environment' | 'config-default';
  /**
   * Whether `selected` names a target that exists.
   *
   * False is the interesting case, and the reason this command does not resolve
   * its target the ordinary way — see `survey`.
   */
  readonly selectedDeclared: boolean;
  readonly targets: readonly TargetSummary[];
}

export interface TargetFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  readonly urls?: boolean | undefined;
}

/**
 * The profile, its config, and what it declares — in one pass.
 *
 * **Deliberately not `resolveProfile`.** That helper resolves the target the way
 * every other command needs it resolved: by refusing a name that is not
 * declared. Here that is exactly backwards. `LANES_LINK_TARGET=clod` is the
 * state in which every other command has just started failing, and this is the
 * command someone runs to find out why — so it has to survive the condition it
 * exists to diagnose. It resolves the name with `askedTarget` and reports
 * whether it landed on anything, rather than throwing. `readProfiles` in
 * `profile.ts` declines to parse configs for the same reason.
 */
async function survey(
  flags: TargetFlags,
  options: { urls?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ resolution: Resolution; config: Config; listing: TargetListing }> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  const selection = await resolveSelection({
    ...(flags.profile !== undefined ? { profileFlag: flags.profile } : {}),
    ...(flags.target !== undefined ? { targetFlag: flags.target } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const { config } = await loadProfileConfig(selection.workspaceRoot, selection.profile);

  const asked = askedTarget(flags.target, env);
  const selected = asked.target ?? config.instance.default_target;
  const names = Object.keys(config.targets);

  const summaries: TargetSummary[] = names.map((name) => {
    const declared = config.targets[name]!;
    return {
      name,
      isDefault: name === config.instance.default_target,
      isSelected: name === selected,
      credentials: declared.credentials.adapter,
      storage: declared.storage.adapter,
      vault: declared.vault?.adapter ?? 'file',
      deployed: declared.deploy !== undefined,
      deployment: deploymentIdentity(declared.deploy),
    };
  });

  return {
    resolution: { ...selection, target: selected, targetSource: asked.source ?? 'config-default' },
    config,
    listing: {
      root: selection.workspaceRoot,
      profile: selection.profile,
      path: selection.profilePath,
      default: config.instance.default_target,
      selected,
      selectedSource: asked.source ?? 'config-default',
      selectedDeclared: names.includes(selected),
      // Asking the platform is opt-in: one `gcloud` subprocess per deployable
      // target, and the profiles that make this command worth running are
      // exactly the ones with several. A discovery command that takes ten
      // seconds and needs a cloud CLI installed is one nobody runs twice —
      // `outputs --target X` is already the command that asks.
      targets: options.urls === true ? await withUrls(config, summaries) : summaries,
    },
  };
}

/** What `--json` and the tests want, without the rendering. */
export async function readTargets(
  flags: TargetFlags,
  options: { urls?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<TargetListing> {
  return (await survey(flags, options)).listing;
}

/** Every deployable target's address, asked for at once rather than in turn. */
async function withUrls(
  config: Config,
  summaries: readonly TargetSummary[],
): Promise<TargetSummary[]> {
  return waiting('asking the platform for addresses', () =>
    Promise.all(
      summaries.map(async (summary) => ({
        ...summary,
        // Resolves to null immediately for a target with no deployment, and
        // swallows a missing or unauthenticated `gcloud` — neither is a reason
        // for a listing to fail.
        url: await deployedUrl(config.targets[summary.name]?.deploy),
      })),
    ),
  );
}

export async function targetList(flags: TargetFlags): Promise<void> {
  const { resolution, listing } = await survey(flags, { urls: flags.urls === true });

  return emit(flags.json, listing, () => {
    announce(resolution);
    print();

    table(
      listing.targets.map((target) => [
        `  ${target.isDefault ? style.green('*') : ' '} ${target.isSelected ? style.cyan('→') : ' '}`,
        style.bold(target.name),
        style.dim(target.credentials),
        style.dim(target.storage),
        deploymentCell(target),
      ]),
    );

    print();
    print(style.dim(`  ${style.green('*')}  instance.default_target — what commands run against`));
    print(style.dim(`  ${style.cyan('→')}  what this shell resolves to right now`));

    // Printed only when the two disagree, which is the whole reason both markers
    // exist. Saying it every time would train people to stop reading it.
    if (listing.selectedSource === 'environment') {
      print(
        style.dim(
          `     ${TARGET_ENV}=${listing.selected} is set in this shell and overrides the file.`,
        ),
      );
    }

    if (!listing.selectedDeclared) {
      print();
      print(
        warn(
          `"${listing.selected}" is not declared here — every command will refuse until it is ` +
            (listing.selectedSource === 'environment' ? `unset (${TARGET_ENV}).` : 'corrected.'),
        ),
      );
    }
  });
}

function deploymentCell(target: TargetSummary): string {
  if (target.url) return style.dim(target.url);
  if (!target.deployment) return style.dim('—');

  const { platform, service, region } = target.deployment;
  // `url === null` means the platform was asked and did not answer; a missing
  // `url` key means nobody asked. Saying which beats printing the same dash.
  const asked = target.url === null ? style.dim('  (no address yet)') : '';
  return `${style.dim(`${platform}  ${service}  ${region}`)}${asked}`;
}

/**
 * `lanes link target use <name>` — rewrite `instance.default_target`.
 *
 * The persisted half of the switch, and a *declared* one: the value lands in the
 * profile YAML, where the operator can read it, `check` validates it, and every
 * command prints that it came from there. That is the distinction `#profile`'s
 * `workspace.ts` draws — what was rejected is hidden per-shell state in a
 * dotfile nothing prints, not a default written where defaults already live.
 */
export async function targetUse(name: string | undefined, flags: GlobalFlags): Promise<void> {
  if (!name) throw new Error('Usage: lanes link target use <name>');

  const selection = await resolveSelection({
    ...(flags.profile !== undefined ? { profileFlag: flags.profile } : {}),
  });
  const { config } = await loadProfileConfig(selection.workspaceRoot, selection.profile);

  // Where this profile stands before the edit, not what the edit will make true.
  announce({
    ...selection,
    target: config.instance.default_target,
    targetSource: 'config-default',
  });

  // `name` is an argument being validated, not a selection being resolved, so
  // no environment gets a say in whether it exists.
  if (!(name in config.targets)) throw undeclaredTarget(name, config);

  if (config.instance.default_target === name) {
    print(ok(`${style.bold(name)} is already the default`));
    return;
  }

  const document = await ConfigDocument.open(selection.workspaceRoot, selection.profile);
  document.setIn(['instance', 'default_target'], name);
  await document.save();

  print(ok(`default target is now ${style.bold(name)}`));

  // Otherwise the operator edits the file, sees nothing change, and concludes
  // the command is broken. The variable is the thing that is winning.
  const fromEnv = process.env[TARGET_ENV];
  if (fromEnv && fromEnv !== name) {
    print(warn(`${TARGET_ENV}=${fromEnv} is set in this shell, and still wins over the file.`));
  }
}

/**
 * `lanes link target show [name]` — one target's adapters, and where it answers.
 *
 * The deep counterpart to `list`, and the one that *does* ask the platform: one
 * target, one subprocess, and you named it. Nothing else prints a target's
 * adapter set — `config show` dumps the whole file as JSON — which is what earns
 * this its place beside `outputs`.
 */
export async function targetShow(name: string | undefined, flags: TargetFlags): Promise<void> {
  const { config, listing } = await survey(flags);
  const wanted = name ?? listing.selected;
  const summary = listing.targets.find((candidate) => candidate.name === wanted);

  if (!summary) throw undeclaredTarget(wanted, config, listing.selectedSource);

  const url = summary.deployment
    ? await waiting('asking the platform for an address', () =>
        deployedUrl(config.targets[wanted]?.deploy),
      )
    : null;

  return emit(flags.json, { ...summary, url }, () => {
    print(style.dim(`${listing.profile}  ${listing.path}`));

    heading(summary.name);
    table([
      ['  credentials', summary.credentials],
      ['  storage', summary.storage],
      ['  vault', summary.vault],
    ]);

    if (!summary.deployment) {
      print();
      print(style.dim('  No deployment — this target runs wherever the CLI does.'));
      return;
    }

    heading('Deployment');
    table([
      ['  platform', summary.deployment.platform],
      ['  service', summary.deployment.service],
      ['  region', summary.deployment.region],
      ...(summary.deployment.project ? [['  project', summary.deployment.project]] : []),
      ['  address', url ?? style.dim('not answering — is it deployed?')],
    ]);
  });
}
