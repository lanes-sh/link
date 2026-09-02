import {
  ConfigError,
  layout,
  listProfiles,
  readWorkspaceFile,
  workspaceFiles,
  writeWorkspaceFile,
  WORKSPACE_FILE,
} from '#profile';
import { parseDocument } from 'yaml';
import { ConfigDocument } from './config-edit.ts';
import { C3 } from './contract3-layout.ts';
import { grantingProfiles, planMoves, type DataPlan } from './contract4-data.ts';
import { applyMoves, assertOneObjectPerDestination } from './migrate-move.ts';

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
  options: { apply: boolean } = { apply: true },
): Promise<Contract4Migration> {
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
  const plan = await planMoves(files, grantingProfiles(configs), profiles);

  // Everything that can refuse, before the first byte moves. A `keep` move is
  // exempt: two profiles granting one store are *meant* to write one source to
  // two destinations, which is the shape this check exists to catch elsewhere.
  assertOneObjectPerDestination(plan.moves.filter((move) => move.keep !== true));

  const changes = describe(plan, profiles);
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
  await applyMoves(files, plan.moves);

  // Last. The stamp is the record that the migration finished.
  for (const profile of profiles) {
    const document = await ConfigDocument.openKey(workspaceRoot, layout.profileConfig(profile));
    document.setIn(['contract'], 4);
    await document.save();
  }

  return {
    workspaceRoot,
    profiles,
    changes,
    shared: plan.shared,
    orphaned: plan.orphaned,
    alreadyCurrent: false,
  };
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

  return changes;
}
