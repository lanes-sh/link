import { ConfigError } from '#profile';
import type { DeployFlags } from './deploy.ts';
import { activeProject } from './gcp/gcloud.ts';

/**
 * Which target this deploy acts on, named or derived.
 *
 * A target name is a local label, and the one people ended up typing was
 * `cloud` — the docs' example, which says where it is not what it is. Omit the
 * flag and this derives `self-hosted-<project>` from whatever `gcloud` is
 * pointed at, which is *also* the default the survey offers for the project a
 * moment later, so in the ordinary case the name and the project agree.
 *
 * **This is not the inference ADR-037 removed.** That one guessed which of
 * several existing targets a command meant, so a mistake ran against the wrong
 * deployment. This names a target at the moment it is created, where there is
 * nothing to guess between — and an explicit `--workspace` still wins.
 *
 * The two can still diverge: change the project at the survey prompt and the
 * name keeps the old one. It is a label, so nothing breaks, and `lanes link
 * workspace rename` is the fix — which is why that command exists.
 */
export async function resolveDeployTarget(
  flags: DeployFlags,
  /** Injected for tests. The real one shells out to `gcloud`. */
  project0: () => Promise<string | null> = activeProject,
): Promise<string> {
  if (flags.target) return flags.target;

  const project = await project0();
  if (project === null) {
    throw new ConfigError(
      'Name the deployment with --workspace, or point gcloud at a project so this can\n' +
        '  name one for you:\n' +
        '    gcloud config set project <project-id>\n' +
        '  then `lanes link deploy` creates `self-hosted-<project-id>`.',
    );
  }
  return `self-hosted-${project}`;
}
