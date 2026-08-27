import { listProfiles, loadProfileConfig } from '#profile';

/**
 * Whether every profile a deploy sends can actually run on the target it sends them to.
 *
 * A deploy uploads config for a set of profiles and rolls a revision baked with
 * one `LANES_LINK_TARGET`. The endpoint then opens *every* profile it finds in
 * the bucket against that one target — see `openReconciled` — and a profile that
 * does not declare it throws on the way up. The catch there closes the runtimes
 * and rethrows, so the container exits and the revision never goes healthy.
 *
 * That is the whole failure, and its shape is what makes it worth a pre-flight:
 * the profile at fault is usually the one just scaffolded, the operator was not
 * thinking about the deployment when they made it, and the symptom is a revision
 * that will not start — which reads as a problem with the deploy, the image, or
 * the platform. Nothing points at the new profile. Refusing here costs one file
 * read per profile and names it.
 *
 * Its own file, not a private function in `deploy.ts`, for the reason
 * `handoff.ts` gives: `deploy.test.ts` does not import `deploy.ts`, and making
 * it do so would pull the whole CLI runtime into a unit test.
 */

export interface Unservable {
  readonly profile: string;
  /** What it does declare, so the refusal says how far off it is. */
  readonly declares: readonly string[];
}

/**
 * The profiles this deploy would send that the revision could not open.
 *
 * Scoped exactly as `uploadWorkspace` and `repairOwnerLayer` are — by the
 * `--profile` flag, absent meaning the whole workspace — because the set that
 * gets uploaded is the set that gets served, and checking a different one would
 * be checking the wrong question.
 *
 * A profile that cannot be parsed is not reported here. It is already fatal
 * further along, with a better message than this could give, and a YAML error
 * dressed up as "cannot run on cloud" would send someone looking at their
 * targets instead of their syntax.
 */
export async function unservableProfiles(input: {
  readonly workspaceRoot: string;
  readonly profiles: readonly string[] | undefined;
  readonly target: string;
}): Promise<Unservable[]> {
  const found: Unservable[] = [];
  const wanted = input.profiles === undefined ? undefined : new Set(input.profiles);

  for (const name of await listProfiles(input.workspaceRoot)) {
    if (wanted !== undefined && !wanted.has(name)) continue;

    let declared: string[];
    try {
      const { config } = await loadProfileConfig(input.workspaceRoot, name);
      declared = Object.keys(config.targets);
    } catch {
      continue;
    }

    if (!declared.includes(input.target)) found.push({ profile: name, declares: declared });
  }

  return found;
}

/** The refusal, as a block, so the wording is testable without a deploy. */
export function unservableRefusal(found: readonly Unservable[], target: string): string {
  const rows = found
    .map((one) => `        ${one.profile}   declares: ${one.declares.join(', ') || 'nothing'}`)
    .join('\n');

  return (
    `${found.length} profile${found.length === 1 ? '' : 's'} would be uploaded that cannot run on "${target}":\n` +
    `${rows}\n\n` +
    '      The endpoint opens every profile in the bucket with this target, so the\n' +
    '      revision would come up and refuse to start.\n' +
    `        lanes link profile add <name> --target ${target}   declares it on a new one\n` +
    '        --profile <name>                          deploys just the one'
  );
}
