import { newConnectionsTemplate, newProfileTemplate, newWorkspaceTemplate } from '../../config-templates.ts';
import { DEFAULT_SURFACES } from '../../config-repair.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTIONS_FILE,
  readConnections,
  ConfigError,
  WORKSPACE_FILE,
  LEGACY_WORKSPACE_FILE,
  legacyProfileConfig,
  listProfiles,
  profilePath,
  isRemoteWorkspace,
  workspaceFiles,
  writeWorkspaceFile,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
  layout,
} from '#profile';
import { readSession } from '#auth/lanes/session.ts';

/**
 * Writing the profile, as opposed to the command that writes one.
 *
 * The same split `./removal.ts` and `./remove.ts` already make, and for the same
 * reason: what goes on disk is a value a test can assert without a terminal, and
 * the command around it is printing, publishing and provisioning. `profileAdd`
 * in `../profile.ts` is that command.
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
  /**
   * What the endpoint did with it, in a form fit to print.
   *
   * Absent from `createProfile`, which writes the file and tells nobody. It is
   * `profileAdd` that publishes, so it is `profileAdd` that fills this in.
   */
  readonly published?: string;
}

/**
 * Which connection each owner-layer surface sits under, in this workspace.
 *
 * Read from `connections.yaml` rather than assumed, because the ids in that
 * file are assigned in creation order and a workspace whose owner layer arrived
 * in a different order holds them under different ones. A profile written
 * against the wrong ids is refused by `assertGrantsResolve` and then *skipped*
 * by `openReconciled`, so it exists, is never served, and says so only in the
 * endpoint's log.
 *
 * **The first row per provider**, which is the rule `ensureReservedConnection`
 * already applies and states: any instance will do, and taking the first means
 * an operator who renamed theirs does not get a second one bolted on beside it.
 *
 * A surface with no row at all is absent from the map and therefore ungranted.
 * That is the honest outcome: `ensureOwnerLayer` writes both halves on the next
 * `start`, where inventing a ref here would produce a profile that never loads.
 */
async function ownedSurfaces(workspaceRoot: string): Promise<Map<string, string>> {
  const owned = new Map<string, string>();

  // Absent or unreadable is not a failure. `createProfile` seeds the file just
  // above this when the workspace has none, and a workspace holding one that
  // cannot be parsed is a problem for `doctor` rather than a reason to refuse a
  // profile.
  const held = await readConnections(workspaceRoot).catch(() => null);

  for (const surface of DEFAULT_SURFACES) {
    const row = held?.connections.find((one) => one.provider === surface);
    if (row) owned.set(surface, `${surface}.${row.id}`);
  }

  return owned;
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
 * (ADR-052), so `--workspace cloud` writes into the bucket the endpoint there
 * reads from.
 *
 * **Writing it is not enough, and this comment is where that was missed.** It
 * used to say the endpoint "serves it on its next reconcile". There is no next
 * reconcile: a running endpoint lists the profiles once, at boot or at a
 * reload (`openReconciled`), so a profile added underneath one stayed durable
 * and invisible — to `/state`, and so to the dashboard, and to every client —
 * until the revision restarted. `profileAdd` notifies for the same reason every
 * other config edit does; see below.
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
  // **Either name, and an unmigrated workspace is refused rather than
  // shadowed.** `resolveWorkspaceRoot` accepts both markers, so this ran
  // against a contract-3 workspace, found no `workspaces.yaml`, and wrote a
  // fresh template beside `lanes-link.yaml` — `readWorkspace` prefers the new
  // name, so every declared target and deployment record vanished, and
  // `renameRegistry` returns early once the new file exists, so no migration
  // could put them back.
  if (!isRemoteWorkspace(local)) {
    if (existsSync(join(local, LEGACY_WORKSPACE_FILE)) && !existsSync(join(local, WORKSPACE_FILE))) {
      throw new ConfigError(
        `${local} is still laid out the way contract 3 kept it, and adding a profile here would ` +
          'write a second registry beside the one it already has.\n' +
          '  Migrate it first: lanes link doctor --fix --profile <name> --workspace <name>',
      );
    }

    if (!existsSync(join(local, WORKSPACE_FILE))) {
      // `0700`, not the ambient umask. This creates `~/.lanes/link` and, on a
      // machine without the desktop app, `~/.lanes` above it — and what lands
      // inside is `credentials.enc` and its key. The blob store already writes
      // its directories this way (`deployments/adapters/filesystem.ts`); this
      // was the one path that did not, and it is the path that goes first.
      await mkdir(local, { recursive: true, mode: 0o700 });
      await writeFile(join(local, WORKSPACE_FILE), newWorkspaceTemplate(), { mode: 0o600 });
    }
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

  // Both shapes, for the same reason: `listProfiles` sees a contract-3
  // `profiles/<name>.yaml` and this did not, so `profile add personal` wrote a
  // fresh template alongside the operator's own — one name, two files, and the
  // empty one opened. `doctor --fix` then planned a move onto an occupied
  // destination and threw on every rerun.
  for (const key of [layout.profileConfig(name), legacyProfileConfig(name)]) {
    if (await workspaceFiles(root).has(key)) {
      throw new Error(`Profile "${name}" already exists at ${root}/${key}`);
    }
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
  // The signed-in subject, so the profile reaches somebody the moment it
  // exists. Without it every new profile shipped `members: []` while the
  // template writes `authorization: mode: self` — an endpoint that advertises
  // OAuth and lists nobody, where the owner signs in at lanes.sh and is told no
  // profile lists them. A local stdio or CI caller still worked, which is why a
  // smoke test passed: those carry `profiles: undefined` and `mayReach` admits
  // everything.
  //
  // Null when nobody is signed in, which is a real state — `lanes auth login`
  // has not been run yet — and the template then says how to fix it rather than
  // inventing a subject.
  const session = await readSession();

  await writeWorkspaceFile(
    workspaceFiles(root),
    layout.profileConfig(name),
    newProfileTemplate(name, port, await ownedSurfaces(root), session?.subject),
  );

  return { name, path, port, targets: options.targets, copiedFrom: {} };
}
