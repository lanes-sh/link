import {
  loadProfileConfig,
  resolveSelection,
  undeclaredTarget,
  type Config,
  type ProfileSelection,
} from '#profile';
import { ConfigError } from '#profile';
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
  /** Whether this is the one `--target` named, when it named any. */
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
  /** What `--target` named, when it named anything. */
  readonly selected: string | null;
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
): Promise<{ selection: ProfileSelection; config: Config; listing: TargetListing }> {
  const selection = await resolveSelection({
    ...(flags.profile !== undefined ? { profileFlag: flags.profile } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const { config } = await loadProfileConfig(selection.workspaceRoot, selection.profile);

  const selected = flags.target ?? null;
  const names = Object.keys(config.targets);

  const summaries: TargetSummary[] = names.map((name) => {
    const declared = config.targets[name]!;
    return {
      name,
      isSelected: name === selected,
      credentials: declared.credentials.adapter,
      storage: declared.storage.adapter,
      vault: declared.vault?.adapter ?? 'file',
      deployed: declared.deploy !== undefined,
      deployment: deploymentIdentity(declared.deploy),
    };
  });

  return {
    selection,
    config,
    listing: {
      root: selection.workspaceRoot,
      profile: selection.profile,
      path: selection.profilePath,
      selected,
      selectedDeclared: selected === null || names.includes(selected),
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
  const { listing } = await survey(flags, { urls: flags.urls === true });

  return emit(flags.json, listing, () => {
    print(style.dim(`${listing.profile}  ${listing.path}`));
    print();

    table(
      listing.targets.map((target) => [
        `  ${target.isSelected ? style.cyan('→') : ' '}`,
        style.bold(target.name),
        style.dim(target.credentials),
        style.dim(target.storage),
        deploymentCell(target),
      ]),
    );

    print();

    // This command takes no required `--target`, and that is not an oversight:
    // it is the command you run to find out what to pass. Requiring the answer
    // as input would be circular, and it has to keep working in the state every
    // other command fails in — which is what `selectedDeclared` reports.
    if (listing.selected === null) {
      print(style.dim('  Every other command names one of these with --target.'));
      return;
    }

    print(style.dim(`  ${style.cyan('→')}  the target you named`));

    if (!listing.selectedDeclared) {
      print();
      print(warn(`"${listing.selected}" is not declared here — every command naming it will refuse.`));
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
 * `lanes link target use <name>` — removed.
 *
 * It wrote `instance.default_target`, which nothing reads (ADR-037). A command
 * that writes a key nothing reads is worse than no command at all: it reports
 * success and changes nothing observable, which is the exact failure this whole
 * change exists to remove.
 *
 * Kept as a refusal rather than deleted outright, for one release. Falling
 * through to `Unknown: lanes link target use` would send someone hunting a typo
 * in a command they have run for months.
 */
export function targetUse(name: string | undefined): never {
  throw new ConfigError(
    'lanes link target use was removed.\n' +
      '  Nothing reads instance.default_target any more — pass --target on every\n' +
      '  command instead:\n' +
      `    lanes link status --profile <name> --target ${name ?? '<target>'}\n` +
      '  If the key is still in your profile it is inert, and safe to delete.',
  );
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

  // Positionally or by flag, but one of them: this command's whole subject is a
  // single target, and there is no default left to mean "the one you would have
  // got". `list` is the command for "I do not know which".
  const wanted = name ?? listing.selected;
  if (!wanted) {
    throw new ConfigError(
      'Usage: lanes link target show <name> --profile <name>\n' +
        `  Declared here: ${listing.targets.map((one) => one.name).join(', ') || 'none'}`,
    );
  }

  const summary = listing.targets.find((candidate) => candidate.name === wanted);
  if (!summary) throw undeclaredTarget(wanted, config, listing.profile);

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
