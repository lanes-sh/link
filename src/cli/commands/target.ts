import { describeKnowledge } from '#deployments/knowledge.ts';
import {
  isPointer,
  listProfiles,
  notInRegistry,
  openTarget,
  readRegistry,
  resolveWorkspaceRoot,
  type WorkspaceTarget,
} from '#profile';
import { ConfigError } from '#profile';
import { deployedUrl, deploymentIdentity, type DeploymentIdentity } from '../endpoint-url.ts';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, heading, ok, print, style, table, waiting, warn } from '../output.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link target` — the targets this workspace knows, and where each lives.
 *
 * A target names *a workspace*: a credential store, a blob store, optionally a
 * deployment, and the profiles that live in it. Under ADR-052 it is declared
 * once, by the workspace that is it — not once per profile, which is what let
 * two profiles disagree about whether a running deployment existed.
 *
 * So this command no longer takes `--profile`. It never really wanted one: the
 * question is "what can I pass to --target", and that had the same answer for
 * every profile in all but the broken cases.
 *
 * **`list` does not follow pointers.** A registry entry either declares its
 * adapters here or names the workspace that does, and following the second kind
 * is a network read per entry. `list` prints what the registry says, so it stays
 * instant and works offline; `show` follows one target and reports what is
 * really there. That split is why a listing can be trusted when the bucket is
 * unreachable — which is exactly when someone is running it.
 *
 * Each command is a data function plus a printing wrapper, the split
 * `profile.ts` uses and for the same reason: `--json` wants the facts without
 * the rendering.
 */

export interface TargetSummary {
  readonly name: string;
  /** Whether this is the one `--target` named, when it named any. */
  readonly isSelected: boolean;
  /**
   * Where the declaration lives: `null` for one this workspace makes itself,
   * otherwise the workspace it points at.
   *
   * The whole listing hangs off this. A pointer's adapters are not read by
   * `list`, so every field below it is null for one — which is honest rather
   * than lossy: they are somewhere else, and `show` is the command that goes.
   */
  readonly pointsAt: string | null;
  readonly credentials: string | null;
  readonly storage: string | null;
  readonly vault: string | null;
  /**
   * Where memory and skills are kept, when that is not `storage` above.
   *
   * Null is the ordinary answer. It is here because a `knowledge:` block moves
   * two of the four things this target holds, and the config file would
   * otherwise be the only witness — a `storage: filesystem` row that is true of
   * the log and the state and false of the owner's own notes.
   */
  readonly knowledge: string | null;
  /** Whether a deployment is declared. Unknown, and false, for a pointer. */
  readonly deployed: boolean;
  readonly deployment: DeploymentIdentity | null;
  /** Only when asked for; absent is "not asked", null is "asked, no answer". */
  readonly url?: string | null;
}

export interface TargetListing {
  readonly root: string;
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
 * The registry, and what each entry says about itself — in one pass.
 *
 * **Deliberately not `resolveProfile`.** That helper resolves the target the way
 * every other command needs it resolved: by refusing a name that is not
 * declared. Here that is exactly backwards. `--target clod` is the state in
 * which every other command has just started failing, and this is the command
 * someone runs to find out why — so it has to survive the condition it exists to
 * diagnose. It reports whether the name landed on anything rather than throwing.
 * `readProfiles` in `profile.ts` declines to parse configs for the same reason.
 *
 * It reads no profile at all now. The registry is the answer, and it is one file
 * (ADR-052).
 */
async function survey(
  flags: TargetFlags,
  options: { urls?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ root: string; listing: TargetListing }> {
  const root = resolveWorkspaceRoot(options.env !== undefined ? { env: options.env } : {});
  const registry = await readRegistry(root);

  const selected = flags.target ?? null;
  const names = Object.keys(registry).sort();

  const summaries: TargetSummary[] = names.map((name) => {
    const entry = registry[name]!;
    return summarise(name, entry, name === selected);
  });

  return {
    root,
    listing: {
      root,
      selected,
      selectedDeclared: selected === null || names.includes(selected),
      // Asking the platform is opt-in: one `gcloud` subprocess per deployable
      // target, and the workspaces that make this command worth running are
      // exactly the ones with several. A discovery command that takes ten
      // seconds and needs a cloud CLI installed is one nobody runs twice —
      // `outputs --target X` is already the command that asks.
      targets: options.urls === true ? await withUrls(registry, summaries) : summaries,
    },
  };
}

/** One entry, rendered without following it. */
function summarise(name: string, entry: WorkspaceTarget, isSelected: boolean): TargetSummary {
  if (isPointer(entry)) {
    return {
      name,
      isSelected,
      pointsAt: entry.workspace,
      credentials: null,
      storage: null,
      vault: null,
      knowledge: null,
      deployed: false,
      deployment: null,
    };
  }

  return {
    name,
    isSelected,
    pointsAt: null,
    credentials: entry.credentials?.adapter ?? null,
    storage: entry.storage?.adapter ?? null,
    vault: entry.vault?.adapter ?? 'file',
    knowledge: null,
    deployed: entry.deploy !== undefined,
    deployment: deploymentIdentity(entry.deploy),
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
  registry: Record<string, WorkspaceTarget>,
  summaries: readonly TargetSummary[],
): Promise<TargetSummary[]> {
  return waiting('asking the platform for addresses', () =>
    Promise.all(
      summaries.map(async (summary) => ({
        ...summary,
        // Resolves to null immediately for a target with no deployment, and
        // swallows a missing or unauthenticated `gcloud` — neither is a reason
        // for a listing to fail.
        url: await deployedUrl(registry[summary.name]?.deploy),
      })),
    ),
  );
}

export async function targetList(flags: TargetFlags): Promise<void> {
  const { listing } = await survey(flags, { urls: flags.urls === true });

  return emit(flags.json, listing, () => {
    print(style.dim(listing.root));
    print();

    table(
      listing.targets.map((target) => [
        `  ${target.isSelected ? style.cyan('→') : ' '}`,
        style.bold(target.name),
        // A pointer says where it lives instead of what it is made of. Its
        // adapters are declared in that workspace and reading them is a network
        // call `list` deliberately does not make.
        ...(target.pointsAt !== null
          ? [style.dim(target.pointsAt), '', '']
          : [
              style.dim(target.credentials ?? ''),
              style.dim(target.storage ?? ''),
              deploymentCell(target),
            ]),
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
 * The deep counterpart to `list`, and the one that *does* go and look: it
 * follows a pointer to the workspace that declares the target, then asks the
 * platform for the address. One target, one hop, one subprocess, and you named
 * it. Nothing else prints a target's adapter set — `config show` dumps a
 * profile, which no longer carries one — which is what earns this its place
 * beside `outputs`.
 */
export async function targetShow(name: string | undefined, flags: TargetFlags): Promise<void> {
  const { root, listing } = await survey(flags);

  // Positionally or by flag, but one of them: this command's whole subject is a
  // single target, and there is no default left to mean "the one you would have
  // got". `list` is the command for "I do not know which".
  const wanted = name ?? listing.selected;
  if (!wanted) {
    throw new ConfigError(
      'Usage: lanes link target show <name>\n' +
        `  Declared here: ${listing.targets.map((one) => one.name).join(', ') || 'none'}`,
    );
  }

  const resolved = await openTarget(root, wanted);
  const summary = summarise(wanted, { ...resolved.declared, ...resolved.entry }, true);
  const profiles = await listProfiles(resolved.workspaceRoot);

  const url = summary.deployment
    ? await waiting('asking the platform for an address', () =>
        deployedUrl(resolved.declared.deploy),
      )
    : null;

  return emit(flags.json, { ...summary, workspace: resolved.workspaceRoot, profiles, url }, () => {
    print(style.dim(resolved.workspaceRoot));

    heading(summary.name);
    table([
      ['  workspace', resolved.workspaceRoot],
      ['  profiles', profiles.join(', ') || style.dim('none yet')],
      ['  credentials', summary.credentials ?? ''],
      ['  storage', summary.storage ?? ''],
      ['  vault', summary.vault ?? ''],
      ...(summary.knowledge
        ? [['  knowledge', summary.knowledge, style.dim('memory and skills')]]
        : []),
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
