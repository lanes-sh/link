import {
  ConfigError,
  listProfiles,
  profilePath,
  readWorkspace,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';

import { createProfile, type ProfileCreated } from './profile/create.ts';
import { recordConfigChange } from '../audit-change.ts';
import { provisionProfiles } from '#deployments/provision-profile.ts';
import { nextAfterEdit, publishProfileEdit, type PublishOutcome } from '../publish.ts';
import { resolveProfile } from '../runtime.ts';
import { emit, ok, print, style, table, warn } from '../output.ts';

// Re-exported because this module is the one every caller already names, and the
// split under it is about file size rather than about the surface. Same shape as
// `selection.ts` re-exporting `ACCEPTS`.
export { createProfile, type ProfileCreated };

/**
 * Profile management.
 *
 * One profile = one config = one instance = one endpoint. Profiles never share
 * a database, a credential store, or a URL, so each new one gets its own port
 * by default — running personal and work side by side is the normal case, not
 * an advanced one.
 *
 * Each command is a data function plus a printing wrapper. The split exists
 * because `--json` needs the facts without the rendering, which is the same
 * reason `startEndpoint` takes an `EndpointReporter` — a caller that is not a
 * terminal should not have to parse one.
 */

export interface ProfileListing {
  readonly root: string;
  readonly default: string | undefined;
  readonly profiles: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

/**
 * Every profile in one target's workspace, and which one is the default.
 *
 * **It takes a target, and that is the whole point of ADR-052.** A profile lives
 * in exactly one target's workspace, so "which profiles exist" is a question
 * about a target rather than about this machine — `personal` on `local` and
 * `personal` on `cloud` are two files in two places, and listing the local
 * directory for both is precisely the confusion this change removes.
 *
 * Names and paths only — deliberately not each profile's port, which would mean
 * parsing every config. One unparseable profile would then fail the command
 * that tells you which profiles exist, and that is exactly when you need it.
 * `status --json` reports the endpoint for a profile you have named.
 */
export async function readProfiles(target: string): Promise<ProfileListing> {
  const local = resolveWorkspaceRoot();
  const root = await resolveTargetWorkspace(local, target);
  const profiles = await listProfiles(root);
  const workspace = await readWorkspace(root);

  return {
    root,
    default: workspace?.default_profile,
    profiles: profiles.map((name) => ({ name, path: profilePath(root, name) })),
  };
}

/**
 * The line a *creation* ends on, where one is worth printing.
 *
 * The one place this differs from the seven commands that publish an edit. They
 * change a config that is already being served, so "nothing answered" is always
 * worth saying — a stale endpoint is serving the previous answer to a question
 * somebody has already asked. A profile is new: nothing is holding a stale view
 * of it, and on a fresh workspace `profile add` is the first command anybody
 * runs, so that line arrived as the first sentence this CLI ever printed and
 * described an endpoint they had not set up yet.
 *
 * So: when the endpoint took the edit, and when the target publishes somewhere.
 * The second is what makes a deployed workspace always say something — that is
 * the case this whole change exists for, where a notify that did not land is
 * exactly the surprise being fixed, and silence is what made it a surprise.
 */
export function publishedAfterCreate(outcome: PublishOutcome): string | undefined {
  return outcome.served || outcome.published !== undefined ? nextAfterEdit(outcome) : undefined;
}

export async function profileAdd(
  name: string,
  options: { targets: readonly string[]; nonInteractive?: boolean; json?: boolean },
): Promise<void> {
  if (options.targets.length === 0) {
    throw new ConfigError(
      'Say which targets this profile declares:\n' +
        `  lanes link profile add ${name} --workspace local\n` +
        `  lanes link profile add ${name} --workspace local --workspace cloud\n` +
        '\n' +
        '  A target is where a profile runs — a credential store and a blob store.\n' +
        '  There is no default to inherit before the profile exists.',
    );
  }

  const primary = options.targets[0]!;

  // **A profile that is already there is provisioned rather than refused**, and
  // that is why there is no second verb for it. What a deployed target needs
  // doing to serve a profile is the same work whether the profile was written a
  // moment ago or last month — so a command that only did it while creating
  // would leave every profile that predates this one reachable by nothing but a
  // full deploy. `add` is the word for "make this profile usable here".
  //
  // It is still not an overwrite: nothing is rewritten, and `createProfile`
  // keeps refusing to write a second file over an existing one.
  const already = await declaredAlready(primary, name);
  const created = already ? null : await createProfile(name, options);

  // Re-read rather than assembled from `created`, because the file on disk is
  // what a workspace with a remote credential store needs to open one.
  const { resolution, config } = await resolveProfile({ profile: name, target: primary });
  const facts = {
    name,
    path: resolution.profilePath,
    port: config.instance.port,
    targets: options.targets,
    copiedFrom: created?.copiedFrom ?? {},
    ...(already ? { existed: true } : {}),
  };

  // Only what actually changed the config. Provisioning an existing profile
  // creates cloud resources and edits nothing here, so recording it as an `add`
  // would put a config change in the log that no file reflects.
  if (created) {
    await recordConfigChange(config, resolution.workspaceRoot, primary, {
      capability: 'config.profile.add',
      scope: name,
      arguments: { port: created.port, workspace: primary },
    });
  }

  // **Before the notify, and that ordering is the whole of it.** A running
  // revision reads a credential by reference at request time, so what a profile
  // created since the last rollout is missing is the secret container and the
  // grant that lets the runtime identity read it — not a revision. Reload first
  // and the endpoint asks for a ref no binding covers, takes the 403 that Secret
  // Manager returns instead of a 404, and skips the profile for the life of that
  // generation. It would then have been *told* about a profile it had just
  // decided it could not open.
  //
  // Unconditional, because "which targets need this" is a question the target
  // already answers: `provisionProfiles` returns `applicable: false` for one
  // that declares no deployment, so a local workspace reaches no cloud and a
  // deployed one always gets what it needs. A flag here would only let somebody
  // create the broken state on purpose.
  //
  // Never fatal, for the same reason the publish below is not: the profile is on
  // disk either way. A missing cloud CLI or a refused IAM call comes back as a
  // reason and is printed as a next step. See `provisionProfiles`.
  const provisioned = await provisionProfiles({
    workspaceRoot: resolution.workspaceRoot,
    target: primary,
    profiles: [name],
  });

  // Told to the endpoint that has to serve it, exactly as every other config
  // edit tells it (ADR-029). This was the one edit that did not, and a profile
  // created against a live workspace was invisible until the endpoint next
  // started — see the header.
  //
  // It matters just as much on the path where nothing was created: a generation
  // that already skipped this profile holds that decision until it re-reads, so
  // provisioning without the reload would fix the credentials and change
  // nothing anybody can see.
  //
  // **Wrapped, because this must not be able to fail the creation.** `profile
  // add` is the command that may have *just written* the workspace it is
  // publishing to, so the credential store the notify authenticates with can be
  // opened before one exists. `publishAndNotify` already treats a failed
  // publish as reportable rather than fatal; this extends that to the store it
  // opens before reaching that guard. The profile is on disk either way, and a
  // creation that succeeded must not report failure.
  let outcome: PublishOutcome;
  try {
    outcome = await publishProfileEdit({ resolution, config, target: primary });
  } catch (error) {
    const reason =
      error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    outcome = { served: false, reason };
  }

  const published = publishedAfterCreate(outcome);

  return emit(
    options.json,
    {
      ...facts,
      ...(published ? { published } : {}),
      ...(provisioned.reason ? { provisioning: provisioned.reason } : {}),
    },
    () => {
      print(
        ok(
          already
            ? `${style.bold(name)} already exists — made sure ${primary} can serve it`
            : `created profile ${style.bold(name)}`,
        ),
      );
      print(`      config   ${facts.path}`);
      print(`      port     ${facts.port}`);
      print(`      workspace  ${options.targets.join(', ')}`);

      for (const [target, from] of Object.entries(facts.copiedFrom)) {
        print(`      ${style.dim(`${target} adapters copied from profile "${from}"`)}`);
      }

      // Named rather than folded into the serving line, because they fail
      // independently: provisioning can succeed against a target whose endpoint
      // is not answering, and a reachable endpoint can refuse a profile whose
      // grants were never provisioned. One line each says which happened.
      if (provisioned.reason) {
        print(warn(`could not provision credentials for ${name}: ${provisioned.reason}`));
        print(
          style.dim(
            `      The endpoint cannot open it until this is fixed. Retry with: ` +
              `lanes link profile add ${name} --workspace ${primary}`,
          ),
        );
      }

      if (published) print(`      ${style.dim(published)}`);

      print();
      print(
        style.dim(`Next: lanes link connect example --profile ${name} --workspace ${primary}`),
      );
    },
  );
}

/**
 * Whether this target's workspace already holds a profile by this name.
 *
 * False on any failure, deliberately. A workspace that does not exist yet and a
 * target nothing declares both land here on the first `profile add` of a new
 * install — and neither is a reason to refuse, because `createProfile` is what
 * bootstraps the first workspace and what reports a target properly when it
 * cannot. Guessing "not there" sends both to the path that handles them.
 */
async function declaredAlready(target: string, name: string): Promise<boolean> {
  try {
    const root = await resolveTargetWorkspace(resolveWorkspaceRoot(), target);
    return (await listProfiles(root)).includes(name);
  } catch {
    return false;
  }
}

export async function profileList(
  target: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const listing = await readProfiles(target);

  return emit(options.json, listing, () => {
    if (listing.profiles.length === 0) {
      print(style.dim(`No profiles in ${listing.root}.`));
      print(style.dim('Create one with: lanes link profile add personal --workspace local'));
      return;
    }

    print(style.dim(listing.root));
    table(
      listing.profiles.map((profile) => [
        profile.name === listing.default ? style.green('*') : ' ',
        style.bold(profile.name),
        style.dim(profile.path),
      ]),
    );
  });
}

/**
 * `lanes link profile default <name>` — removed.
 *
 * It wrote `default_profile`, which nothing reads (ADR-037). A command that
 * writes a key nothing reads reports success and changes nothing observable,
 * which is the failure this change exists to remove.
 *
 * A refusal rather than a deletion, for one release: falling through to
 * "Unknown: lanes link profile default" would send someone hunting a typo in a
 * command they have run for months.
 */
export function profileDefault(name: string | undefined): never {
  throw new ConfigError(
    'lanes link profile default was removed.\n' +
      '  Nothing reads default_profile any more — pass --profile on every command:\n' +
      `    lanes link status --profile ${name ?? '<name>'} --workspace <name>\n` +
      '  If the key is still in workspaces.yaml it is inert, and safe to delete.',
  );
}

// The bundled agent skill used to be printed from here, because `installRoot`
// was already imported for it. It belongs with the other documents this CLI
// ships to a client — see `commands/mcp/assets.ts`.
