import { listProfiles, loadProfileConfig, ConfigError, type TargetConfig } from '#profile';
import { ask, isInteractive } from '../../prompt.ts';
import { print, style } from '../../output.ts';

/**
 * The targets a new profile declares, and where their values come from.
 *
 * `profile add` used to emit exactly one target — `local`, hard-coded in the
 * template — while accepting a `--target` it dropped on the floor. So the
 * command that creates a profile could not create the thing a profile is mostly
 * *for*: somewhere to run.
 *
 * A `local` target is derivable and never asked about: a path under the
 * workspace, an encrypted file beside it. Anything else names a cloud account,
 * and this is the one place in the CLI where guessing those is actively harmful.
 * `deploy`'s survey proposes a *fresh* project id (`lanes-link-<random>`),
 * which is right for a first deploy and exactly wrong here — pressing return
 * would build a second, separate deployment rather than adding this profile to
 * the one the operator already has. So the defaults come from a sibling profile
 * that already declares the same target name, and the service name is the only
 * one derived, because that is the one field that has to differ per profile.
 */

export interface DeclaredTarget {
  readonly name: string;
  /** Rendered YAML, indented two spaces, ready to sit under `targets:`. */
  readonly block: string;
  /** Which profile the values were taken from, when they were taken from one. */
  readonly from?: string;
}

/** The `local` target, which is the same shape in every profile. */
export function localBlock(profile: string, name = 'local'): string {
  return (
    `  ${name}:\n` +
    `    credentials: { adapter: file, path: ./data/${profile}/credentials.enc }\n` +
    `    storage: { adapter: filesystem, path: ./data/${profile} }\n`
  );
}

/**
 * A sibling profile's declaration of the same target name, if there is one.
 *
 * The first match wins rather than the operator being asked which — two
 * profiles declaring `cloud` against different projects is possible and rare,
 * and the values are shown and editable at the prompt either way.
 */
export async function siblingTarget(
  workspaceRoot: string,
  target: string,
  exclude: string,
): Promise<{ profile: string; declared: TargetConfig } | null> {
  for (const name of await listProfiles(workspaceRoot)) {
    if (name === exclude) continue;

    try {
      const { config } = await loadProfileConfig(workspaceRoot, name);
      const declared = config.targets[target];
      if (declared) return { profile: name, declared };
    } catch {
      // A profile that will not parse is not a source of defaults, and saying
      // so here would report a broken sibling as a problem with this command.
    }
  }

  return null;
}

/**
 * Ask for what a non-local target needs, pre-filled from a sibling.
 *
 * Refuses rather than inventing when there is nobody to ask and nothing to copy
 * — the same bargain `connect --non-interactive` makes. A profile written with
 * a guessed project id parses, deploys, and points at the wrong account.
 */
export async function askTarget(input: {
  readonly target: string;
  readonly profile: string;
  readonly sibling: { profile: string; declared: TargetConfig } | null;
  readonly nonInteractive?: boolean;
}): Promise<DeclaredTarget> {
  const { target, profile, sibling } = input;

  if (!sibling) {
    throw new ConfigError(
      `No profile in this workspace declares a target called "${target}", so there is\n` +
        'nothing to copy its adapters from.\n' +
        `  lanes link profile add ${profile} --target local\n` +
        `  lanes link deploy --profile ${profile} --target ${target}\n` +
        '  The deploy surveys for what it does not know and writes the block.',
    );
  }

  const declared = sibling.declared;
  const project = declared.credentials.project ?? '';
  const bucket = declared.storage.bucket ?? '';

  // The one field that must differ: two profiles served by one project need two
  // services, which is what makes them separately deployable.
  const service = `lanes-link-${profile}-mcp`;

  if (input.nonInteractive === true || !isInteractive()) {
    return {
      name: target,
      block: cloudBlock({ target, project, bucket, service, declared }),
      from: sibling.profile,
    };
  }

  print(style.dim(`  ${target} — defaults from profile "${sibling.profile}"`));

  const answeredProject = (await ask(`  Cloud project [${project}]: `)) || project;
  const answeredBucket = (await ask(`  Bucket [${bucket}]: `)) || bucket;
  const answeredService = (await ask(`  Service [${service}]: `)) || service;

  return {
    name: target,
    block: cloudBlock({
      target,
      project: answeredProject,
      bucket: answeredBucket,
      service: answeredService,
      declared,
    }),
    from: sibling.profile,
  };
}

/** One target's YAML, carrying over the adapters the sibling chose. */
function cloudBlock(input: {
  target: string;
  project: string;
  bucket: string;
  service: string;
  declared: TargetConfig;
}): string {
  const { declared } = input;
  const deploy = declared.deploy;

  return (
    `  ${input.target}:\n` +
    `    credentials: { adapter: ${declared.credentials.adapter}, project: ${input.project} }\n` +
    `    storage: { adapter: ${declared.storage.adapter}, bucket: ${input.bucket} }\n` +
    `    vault: { adapter: ${declared.vault?.adapter ?? 'secret'} }\n` +
    (deploy
      ? `    deploy:\n` +
        `      platform: ${deploy.platform}\n` +
        `      project: ${input.project}\n` +
        `      region: ${deploy.region}\n` +
        `      service: ${input.service}\n` +
        `      access: ${deploy.access}\n`
      : '')
  );
}
