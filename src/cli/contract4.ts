import {
  ConfigError,
  layout,
  listProfiles,
  readWorkspaceFile,
  workspaceFiles,
  writeWorkspaceFile,
  WORKSPACE_FILE,
  CONNECTIONS_FILE,
  openTarget,
} from '#profile';
import { parseDocument } from 'yaml';
import { ConfigDocument } from './config-edit.ts';
import { C3 } from './contract3-layout.ts';
import { grantingProfiles, planMoves, type DataPlan, type Renames } from './contract4-data.ts';
import { planRenames } from './contract4-rename.ts';
import { ensureRegistryContract } from './config-repair-sweep.ts';
import {
  assertConnectionsSavable,
  readConnectionRows,
  renameConnections,
  rewriteGrants,
} from './contract4-yaml.ts';
import { applyMoves, assertOneObjectPerDestination } from './migrate-move.ts';
import {
  applyCredentialMoves,
  planCredentialMoves,
  planVaultMoves,
} from './contract4-credentials.ts';
import { openSecretStoreFor } from './runtime/select.ts';
import { buildRegistryWithWorkspace } from './runtime/registry.ts';

/**
 * Contract 3 to contract 4: a profile owns its data again.
 *
 * Contract 3 moved every account up to the workspace and, in the same sweep,
 * moved the owner layer's bytes beside the *connection* — so a profile owned
 * nothing and the shipped default had every profile granting one memory.
 * ADR-066 reverses that half; ADR-067 collapses a profile into one directory
 * and retires `data/`, which had stopped meaning anything once the declaration
 * moved in beside the bytes.
 *
 * Four steps, ordered so a crash between any two leaves a workspace that still
 * opens:
 *
 *   1. The registry is renamed. One document, cannot half-apply.
 *   2. Bytes move — the workspace's up out of `data/`, a profile's into its
 *      directory.
 *   3. Declarations move into the directories they now name.
 *   4. Each profile is stamped `contract: 4`.
 *
 * **The stamp is last, and it is the record that this finished** rather than a
 * step among steps. Contract 3 shipped with it written first, which left
 * profiles claiming the new contract with every byte still at the old path and
 * a rerun that read the stamp and found nothing to do.
 *
 * Every read here goes through `C3`, and every write through `layout`. A
 * migration that asks the live layout for its *source* paths finds nothing to
 * move the moment the next contract lands.
 */

export interface Contract4Migration {
  readonly workspaceRoot: string;
  readonly profiles: readonly string[];
  readonly changes: readonly string[];
  /** Copied into more than one profile, original left. The operator decides. */
  readonly shared: DataPlan['shared'];
  /** Granted by no profile. Left where it is. */
  readonly orphaned: readonly string[];
  readonly alreadyCurrent: boolean;
}

/** Whether this workspace still holds anything at contract 3. */
export async function needsContract4(workspaceRoot: string): Promise<boolean> {
  for (const profile of await listProfiles(workspaceRoot)) {
    const raw = await readProfile(workspaceRoot, profile);
    if (raw !== null && (raw.contract ?? 0) === 3) return true;
  }
  return false;
}

async function readProfile(
  root: string,
  profile: string,
): Promise<{ contract?: number; grants?: { connection?: unknown }[] } | null> {
  const files = workspaceFiles(root);
  // The contract-3 path first: a profile still to be migrated is there, and one
  // already migrated is at the new path. Reading only one shape makes a rerun
  // after an interruption see half a workspace.
  const text =
    (await readWorkspaceFile(files, C3.profile(profile))) ??
    (await readWorkspaceFile(files, layout.profileConfig(profile)));
  if (text === null) return null;
  try {
    return parseDocument(text).toJSON() as { contract?: number };
  } catch {
    return null;
  }
}

export async function migrateToContract4(
  workspaceRoot: string,
  options: { apply: boolean; target?: string } = { apply: true },
): Promise<Contract4Migration> {
  const target = options.target ?? 'local';
  const names = await listProfiles(workspaceRoot);
  const configs = new Map<string, { grants?: { connection?: unknown }[] }>();

  for (const profile of names) {
    const raw = await readProfile(workspaceRoot, profile);
    if (raw !== null && (raw.contract ?? 0) === 3) configs.set(profile, raw);
  }

  if (configs.size === 0) {
    return {
      workspaceRoot,
      profiles: [],
      changes: [],
      shared: [],
      orphaned: [],
      alreadyCurrent: true,
    };
  }

  const profiles = [...configs.keys()];
  const files = workspaceFiles(workspaceRoot);

  // Every connection the workspace holds, and the id each ends up with. Built
  // once and read by every rewrite below — the contract-3 mover's own bug was a
  // map keyed one way and queried the other, which made the resolution a silent
  // no-op and sent two profiles' blobs into one namespace.
  await assertConnectionsSavable(workspaceRoot);

  const rows = await readConnectionRows(workspaceRoot);
  const renames = planRenames(rows);

  const plan = await planMoves(files, grantingProfiles(configs), profiles, renames);

  // Everything that can refuse, before the first byte moves. A `keep` move is
  // exempt: two profiles granting one store are *meant* to write one source to
  // two destinations, which is the shape this check exists to catch elsewhere.
  assertOneObjectPerDestination(plan.moves.filter((move) => move.keep !== true));

  const changes = [...describe(plan, profiles), ...repositoryNotes(configs, renames)];
  if (!options.apply) {
    return {
      workspaceRoot,
      profiles,
      changes,
      shared: plan.shared,
      orphaned: plan.orphaned,
      alreadyCurrent: false,
    };
  }

  await renameRegistry(workspaceRoot);

  // The registry's own stamp, which the byte-for-byte rename carries across
  // unchanged. Here rather than inside `renameRegistry` because that function
  // returns early on a workspace already holding `workspaces.yaml`, which is
  // exactly the workspace whose stamp is stale.
  await ensureRegistryContract(workspaceRoot);
  await applyMoves(files, plan.moves);

  // Credentials before the rows: a ref is derived from the id, so the rows must
  // still name the old one for `planCredentialMoves` to compute the same pair
  // on a rerun.
  const credentials = await moveCredentials(workspaceRoot, target, rows, renames, configs);

  // **The rows are renamed after the grants and before the stamp**, and every
  // window that leaves is one a rerun closes. `connections.yaml` is the only
  // source `planRenames` has, so renaming it before the grants destroyed the
  // map mid-flight: the rerun read the new rows, computed `lan1 → lan1`, found
  // no mapping for `memory.main`, and stamped a profile whose grants named a
  // connection nothing declared — refused at load, and `needsContract4` false,
  // so no migration would ever run again.
  //
  // Both rewrites are idempotent, which is what makes the order safe rather
  // than merely better: a grant already naming the new ref is not in the map
  // and is left alone, and so is a row.
  await rewriteGrants(workspaceRoot, profiles, renames);
  await renameConnections(workspaceRoot, renames);

  // Last. The stamp is the record that the migration finished.
  for (const profile of profiles) {
    const document = await ConfigDocument.openKey(workspaceRoot, layout.profileConfig(profile));
    document.setIn(['contract'], 4);
    await document.save();
  }

  return {
    workspaceRoot,
    profiles,
    changes: [...changes, ...credentials],
    shared: plan.shared,
    orphaned: plan.orphaned,
    alreadyCurrent: false,
  };
}

/**
 * Move each stored credential to the ref its renamed connection now derives.
 *
 * **Throws rather than warns**, and that is the whole of its error handling. It
 * warned once, and the rehearsal that found it showed why it must not: the
 * warning was printed, `renameConnections` ran anyway, and the workspace came
 * out with rows naming `gmail.con1` while the secret sat at
 * `gmail/wjj_andrews`. A rerun cannot repair that — the rows are renamed, so
 * the second run computes no rename for them and the old ref is orphaned with
 * nothing left that knows what it belonged to.
 *
 * Failing here leaves the rows untouched, which is the state a rerun *can*
 * finish from. Bytes that already moved are found in place and skipped.
 */
async function moveCredentials(
  root: string,
  target: string,
  rows: readonly { id: string; provider: string }[],
  renames: Renames,
  profiles: ReadonlyMap<string, { grants?: { connection?: unknown }[] }>,
): Promise<string[]> {
  if (rows.length === 0) return [];

  const [store, registry] = await Promise.all([
    openSecretStoreFor(root, target),
    buildRegistryWithWorkspace(root),
  ]);

  // `readConnectionRows`, not `readConnections`. The latter runs
  // `assertNoRenamedProviders`, which refuses a `tasks` row — and a workspace
  // holding one is exactly the workspace being migrated, so reading through the
  // guard makes the refusal block its own fix. ADR-051's rule, met twice now: a
  // refusal has to name a command, and the command has to be able to run.
  // The vault's document is planned separately because `credentialRefFor`
  // cannot name it — see `planVaultMoves`. One apply for both, so a source
  // feeding several destinations is deleted once rather than per plan.
  const declared = (await openTarget(root, target)).declared;

  return await applyCredentialMoves(store, [
    ...planCredentialMoves(await readConnectionRows(root, true), registry, renames),
    ...(declared.vault?.adapter === 'secret'
      ? planVaultMoves(profiles, renames, declared.vault.ref)
      : []),
  ]);
}

/**
 * `lanes-link.yaml` becomes `workspaces.yaml`.
 *
 * Written then deleted rather than moved, so an interruption leaves both and
 * `readWorkspace` — which prefers the new name — still opens the workspace.
 * Losing this file is losing the address of every target.
 */
async function renameRegistry(root: string): Promise<void> {
  const files = workspaceFiles(root);
  if (await files.has(WORKSPACE_FILE)) return;

  const text = await readWorkspaceFile(files, C3.workspace);
  if (text === null) return;

  await writeWorkspaceFile(files, WORKSPACE_FILE, text);
  if ((await readWorkspaceFile(files, WORKSPACE_FILE)) === null) {
    throw new ConfigError(
      `${WORKSPACE_FILE} did not read back after being written. Nothing has been deleted; ` +
        'fix the store and run this again.',
    );
  }
  await files.delete(C3.workspace);
}

/**
 * What a `knowledge:` repository needs done by hand, named rather than left.
 *
 * A profile keeping its memory and entities in GitHub addresses them by the
 * connection id — an entry reaches the repository as `memory/<id>/<entry>.md`.
 * Contract 4 renames the id, so the provider starts reading `memory/lan1/`
 * while the repository still holds `memory/main/`: `memory_search` returns
 * nothing and `entities_find` finds nobody, with the data sitting intact under
 * the old name and nothing having failed.
 *
 * Not repaired here on purpose. Renaming directories in somebody's repository
 * is a network write to a thing this migration does not own, and `applyMoves`
 * cannot reach a GitHub store at all — so the honest move is to say exactly
 * what to rename, which is one `git mv` per area. `removalPlan` warns about the
 * same class for the same reason.
 */
function repositoryNotes(
  configs: ReadonlyMap<string, { knowledge?: unknown; grants?: { connection?: unknown }[] }>,
  renames: Renames,
): string[] {
  const notes: string[] = [];

  for (const [profile, config] of configs) {
    const repo = (config.knowledge as { repo?: unknown } | undefined)?.repo;
    if (typeof repo !== 'string') continue;

    for (const surface of ['memory', 'entities'] as const) {
      const granted = (config.grants ?? [])
        .map((grant) => grant.connection)
        .find((ref): ref is string => typeof ref === 'string' && ref.startsWith(`${surface}.`));
      if (granted === undefined) continue;

      const to = renames.get(granted);
      if (to === undefined) continue;

      const was = granted.slice(granted.indexOf('.') + 1);
      const now = to.slice(to.indexOf('.') + 1);
      if (was === now) continue;

      notes.push(
        `${repo}: rename ${surface}/${was}/ to ${surface}/${now}/ — "${profile}" reads it by the ` +
          'connection id, and nothing here can write to your repository',
      );
    }
  }

  return notes;
}

function describe(plan: DataPlan, profiles: readonly string[]): string[] {
  const changes = [`${C3.workspace} → ${WORKSPACE_FILE}`];

  for (const profile of profiles) {
    changes.push(`${C3.profile(profile)} → ${layout.profileConfig(profile)}: contract 4`);
  }

  const moved = plan.moves.filter((move) => move.keep !== true).length;
  if (moved > 0) changes.push(`${moved} object(s) moved out of data/`);

  for (const { key, profiles: owners } of plan.shared) {
    changes.push(`${key}: copied into ${owners.join(' and ')} — the original is left for you`);
  }
  for (const key of plan.orphaned) {
    changes.push(`${key}: no profile grants it, so it stays where it is`);
  }

  // Said as what it is. Contract 3 merged these and deliberately did not delete
  // them, so a workspace that came through it still holds a decryptable
  // credential document per profile — and reporting that as an ungranted store
  // reads as tidy-up rather than as a credential left on disk.
  for (const key of plan.leftover) {
    changes.push(
      `${key}: a credential store contract 3 merged and left behind — its contents are in ` +
        `${layout.credentials()} now, so delete it`,
    );
  }

  return changes;
}
