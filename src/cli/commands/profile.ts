import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigError,
  WORKSPACE_FILE,
  listProfiles,
  profilePath,
  readWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { newProfileTemplate, newWorkspaceTemplate } from '../config-edit.ts';
import { askTarget, localBlock, siblingTarget } from './profile/declare.ts';
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
 * The targets are the argument that used to be missing. `--target` was accepted
 * and dropped here, and the template could only ever emit `local` — so the
 * command reported success and produced a profile that could not reach the
 * deployment the operator had just told it about.
 */
export async function createProfile(
  name: string,
  options: { targets: readonly string[]; nonInteractive?: boolean },
): Promise<ProfileCreated> {
  const root = resolveWorkspaceRoot();
  const path = profilePath(root, name);

  if (existsSync(path)) throw new Error(`Profile "${name}" already exists at ${path}`);

  await mkdir(join(root, 'profiles'), { recursive: true });

  // Each profile gets its own port so two can serve at once without an
  // operator having to think about it.
  const existing = await listProfiles(root);
  const port = FIRST_PORT + existing.length;

  // Everything that can fail — a target nobody declares, a prompt nobody can
  // answer — happens before the first write, so a refusal leaves the workspace
  // exactly as it was rather than half a profile behind.
  const blocks: string[] = [];
  const copiedFrom: Record<string, string> = {};

  for (const target of options.targets) {
    if (target === 'local') {
      blocks.push(localBlock(name));
      continue;
    }

    const declared = await askTarget({
      target,
      profile: name,
      sibling: await siblingTarget(root, target, name),
      ...(options.nonInteractive === true ? { nonInteractive: true } : {}),
    });

    blocks.push(declared.block);
    if (declared.from) copiedFrom[target] = declared.from;
  }

  const workspaceFile = join(root, WORKSPACE_FILE);
  if (!existsSync(workspaceFile)) {
    await writeFile(workspaceFile, newWorkspaceTemplate(), { mode: 0o600 });
  }

  await writeFile(path, newProfileTemplate(name, port, blocks.join('')), { mode: 0o600 });

  return { name, path, port, targets: options.targets, copiedFrom };
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
  options: { targets: readonly string[]; nonInteractive?: boolean; json?: boolean },
): Promise<void> {
  if (options.targets.length === 0) {
    throw new ConfigError(
      'Say which targets this profile declares:\n' +
        `  lanes link profile add ${name} --target local\n` +
        `  lanes link profile add ${name} --target local --target cloud\n` +
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

export async function profileList(options: { json?: boolean } = {}): Promise<void> {
  const listing = await readProfiles();

  return emit(options.json, listing, () => {
    if (listing.profiles.length === 0) {
      print(style.dim(`No profiles in ${listing.root}.`));
      print(style.dim('Create one with: lanes link profile add personal --target local'));
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
      `    lanes link status --profile ${name ?? '<name>'} --target <target>\n` +
      '  If the key is still in lanes-link.yaml it is inert, and safe to delete.',
  );
}

// The bundled agent skill used to be printed from here, because `installRoot`
// was already imported for it. It belongs with the other documents this CLI
// ships to a client — see `commands/mcp/assets.ts`.
