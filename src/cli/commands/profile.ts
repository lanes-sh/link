import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  WORKSPACE_FILE,
  listProfiles,
  profilePath,
  readWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { newProfileTemplate, newWorkspaceTemplate } from '../config-edit.ts';
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
  readonly isDefault: boolean;
}

export interface ProfileListing {
  readonly root: string;
  readonly default: string | undefined;
  readonly profiles: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

/** Write a new profile, and the workspace file if this is the first one. */
export async function createProfile(
  name: string,
  options: { default?: boolean },
): Promise<ProfileCreated> {
  const root = resolveWorkspaceRoot();
  const path = profilePath(root, name);

  if (existsSync(path)) throw new Error(`Profile "${name}" already exists at ${path}`);

  await mkdir(join(root, 'profiles'), { recursive: true });

  // Each profile gets its own port so two can serve at once without an
  // operator having to think about it.
  const existing = await listProfiles(root);
  const port = FIRST_PORT + existing.length;

  const workspaceFile = join(root, WORKSPACE_FILE);
  const isFirst = existing.length === 0;
  const isDefault = options.default === true || isFirst;

  if (!existsSync(workspaceFile)) {
    await writeFile(workspaceFile, newWorkspaceTemplate(isDefault ? name : undefined), {
      mode: 0o600,
    });
  } else if (options.default) {
    const document = parseDocument(await Bun.file(workspaceFile).text());
    document.set('default_profile', name);
    await writeFile(workspaceFile, document.toString({ lineWidth: 0 }), { mode: 0o600 });
  }

  await writeFile(path, newProfileTemplate(name, port), { mode: 0o600 });

  return { name, path, port, isDefault };
}

/**
 * Every profile in the workspace, and which one is the default.
 *
 * Names and paths only — deliberately not each profile's port, which would mean
 * parsing every config. One unparseable profile would then fail the command
 * that tells you which profiles exist, and that is exactly when you need it.
 * `status --json` reports the endpoint for a profile you have named.
 */
export async function readProfiles(): Promise<ProfileListing> {
  const root = resolveWorkspaceRoot();
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
  options: { default?: boolean; json?: boolean },
): Promise<void> {
  const created = await createProfile(name, options);

  return emit(options.json, created, () => {
    print(ok(`created profile ${style.bold(created.name)}`));
    print(`      config  ${created.path}`);
    print(`      port    ${created.port}`);
    if (created.isDefault) print(`      set as the workspace default`);
    print();
    print(
      style.dim('Next: lanes link connect example    # add a connection, no credentials needed'),
    );
  });
}

export async function profileList(options: { json?: boolean } = {}): Promise<void> {
  const listing = await readProfiles();

  return emit(options.json, listing, () => {
    if (listing.profiles.length === 0) {
      print(style.dim(`No profiles in ${listing.root}.`));
      print(style.dim('Create one with: lanes link profile add personal --default'));
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

export async function profileDefault(name: string): Promise<void> {
  const root = resolveWorkspaceRoot();
  if (!existsSync(profilePath(root, name))) throw new Error(`Profile "${name}" does not exist`);

  const workspaceFile = join(root, WORKSPACE_FILE);
  const document = existsSync(workspaceFile)
    ? parseDocument(await Bun.file(workspaceFile).text())
    : parseDocument(newWorkspaceTemplate());

  document.set('default_profile', name);
  await writeFile(workspaceFile, document.toString({ lineWidth: 0 }), { mode: 0o600 });

  print(ok(`default profile is now ${style.bold(name)}`));
}

// The bundled agent skill used to be printed from here, because `installRoot`
// was already imported for it. It belongs with the other documents this CLI
// ships to a client — see `commands/mcp/assets.ts`.
