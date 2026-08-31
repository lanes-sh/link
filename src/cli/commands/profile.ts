import { newConnectionsTemplate, newProfileTemplate, newWorkspaceTemplate } from '../config-templates.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTIONS_FILE,
  ConfigError,
  WORKSPACE_FILE,
  listProfiles,
  profilePath,
  readWorkspace,
  isRemoteWorkspace,
  workspaceFiles,
  writeWorkspaceFile,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';

import { emit, ok, print, style, table } from '../output.ts';

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

const FIRST_PORT = 7337;

export interface ProfileCreated {
  readonly name: string;
  readonly path: string;
  readonly port: number;
  /** Every target the new profile declares, in the order they were named. */
  readonly targets: readonly string[];
  /** Which sibling supplied each non-local target's adapters, where one did. */
  readonly copiedFrom: Readonly<Record<string, string>>;
}

export interface ProfileListing {
  readonly root: string;
  readonly default: string | undefined;
  readonly profiles: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

/**
 * Write a new profile, and the workspace file if this is the first one.
 *
 * The target is the argument that used to be missing. `--target` was accepted
 * and dropped here, and the template could only ever emit `local` — so the
 * command reported success and produced a profile that could not reach the
 * deployment the operator had just told it about.
 *
 * It now decides *where the file goes* rather than what is written in it: a
 * profile lives in one target's workspace and declares nothing about it
 * (ADR-052), so `--workspace cloud` writes into the bucket and the endpoint there
 * serves it on its next reconcile.
 */
export async function createProfile(
  name: string,
  options: { targets: readonly string[]; nonInteractive?: boolean },
): Promise<ProfileCreated> {
  const local = resolveWorkspaceRoot();
  const target = options.targets[0]!;

  // The workspace file before the target is resolved, not after. `profile add
  // <name> --workspace local` on an empty directory is how a workspace comes into
  // existence, and the target it names is declared *by* that file — so writing
  // it second means resolving a target nothing has declared yet.
  if (!isRemoteWorkspace(local) && !existsSync(join(local, WORKSPACE_FILE))) {
    await mkdir(local, { recursive: true });
    await writeFile(join(local, WORKSPACE_FILE), newWorkspaceTemplate(), { mode: 0o600 });
  }

  const root = await resolveTargetWorkspace(local, target);
  const path = profilePath(root, name);

  // The connections file comes into existence with the workspace, carrying the
  // owner layer. It is written before the profile because the profile's grants
  // name rows in it, and `assertGrantsResolve` refuses a grant with nothing
  // behind it — so a profile written first would not load until this existed.
  if (!(await workspaceFiles(root).has(CONNECTIONS_FILE))) {
    await writeWorkspaceFile(workspaceFiles(root), CONNECTIONS_FILE, newConnectionsTemplate());
  }

  if (await workspaceFiles(root).has(`profiles/${name}.yaml`)) {
    throw new Error(`Profile "${name}" already exists at ${path}`);
  }

  // Only a directory needs making. A bucket has no directories, and the write
  // that follows creates the key outright.
  if (!isRemoteWorkspace(root)) await mkdir(join(root, 'profiles'), { recursive: true });

  // Each profile gets its own port so two can serve at once without an
  // operator having to think about it.
  const existing = await listProfiles(root);
  const port = FIRST_PORT + existing.length;

  // The prompting that used to happen here is gone. A new profile had to be
  // given an adapter block per target it declared, and for anything but `local`
  // there was nothing safe to derive one from — so the command copied a
  // sibling's, or asked. It declares no target now (ADR-052): it is written into
  // the workspace of the target it was named with, and that workspace already
  // says where its bytes go.
  await writeWorkspaceFile(
    workspaceFiles(root),
    `profiles/${name}.yaml`,
    newProfileTemplate(name, port),
  );

  return { name, path, port, targets: options.targets, copiedFrom: {} };
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

  const created = await createProfile(name, options);

  return emit(options.json, created, () => {
    print(ok(`created profile ${style.bold(created.name)}`));
    print(`      config   ${created.path}`);
    print(`      port     ${created.port}`);
    print(`      targets  ${created.targets.join(', ')}`);

    for (const [target, from] of Object.entries(created.copiedFrom)) {
      print(`      ${style.dim(`${target} adapters copied from profile "${from}"`)}`);
    }

    print();
    print(
      style.dim(
        `Next: lanes link connect example --profile ${created.name} --target ${created.targets[0]}`,
      ),
    );
  });
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
      '  If the key is still in lanes-link.yaml it is inert, and safe to delete.',
  );
}

// The bundled agent skill used to be printed from here, because `installRoot`
// was already imported for it. It belongs with the other documents this CLI
// ships to a client — see `commands/mcp/assets.ts`.
