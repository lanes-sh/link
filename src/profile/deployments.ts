import { parseDocument } from 'yaml';
import { readWorkspaceFile, workspaceFiles, writeWorkspaceFile } from './files.ts';
import { SUPPORTED_CONTRACT, workspaceSchema, type WorkspaceTarget } from './schema.ts';
import { WORKSPACE_FILE } from './workspace.ts';

/**
 * Writing the target registry.
 *
 * ADR-044 kept a deployment *index* here and had to insist it was "an index, not
 * configuration", because a target was declared by the profile and resolving
 * from anything else would have been a second source of truth. ADR-052 removed
 * the thing it was second to: the profile declares no target now, so this file
 * writes the only declaration there is.
 *
 * Which is why the entry shape matters. A workspace that *is* the target writes
 * its adapters; a machine reaching it writes a pointer. `registry.ts` follows
 * one to the other, and the schema refuses an entry trying to be both.
 *
 * Everything goes through the YAML document API, so the comments in a workspace
 * file an operator has annotated survive being written to.
 */

/**
 * Record a target, replacing any earlier entry of the same name.
 *
 * Keyed by name rather than appended, because a workspace has one answer per
 * target by definition — a second entry would be a history, and a history is a
 * thing to read wrong.
 *
 * Merged over the existing entry so a field this caller does not know about —
 * `primary`, on a redeploy that did not ask — is carried forward rather than
 * dropped. That merge is why `deploy` can record a new `last_deploy` without
 * having to re-answer whose token opens the endpoint.
 */
export async function recordTarget(
  workspaceRoot: string,
  target: string,
  entry: WorkspaceTarget,
): Promise<void> {
  await editRegistry(workspaceRoot, (targets) => {
    const previous = targets[target];
    // Neither shape merges into the other, and the symmetry is the point: an
    // entry carrying both a `workspace:` and adapters is what the schema refuses.
    //
    // A pointer replacing a declaration is `deploy` handing the target over to
    // the workspace it just wrote. A declaration replacing a pointer is the same
    // command writing the bucket's own registry — and merging there left the
    // laptop's `workspace:` on it, pointing the bucket at itself.
    targets[target] = { ...pick(previous), ...entry };
  });
}

/** Forget a target. Used by `profile remove --target` once nothing is left in it. */
export async function removeTarget(workspaceRoot: string, target: string): Promise<void> {
  await editRegistry(workspaceRoot, (targets) => {
    delete targets[target];
  });
}

/** The fields that survive an entry changing shape: the deploy record, and only it. */
function pick(previous: WorkspaceTarget | undefined): Partial<WorkspaceTarget> {
  if (!previous) return {};
  return {
    ...(previous.primary ? { primary: previous.primary } : {}),
    ...(previous.last_deploy ? { last_deploy: previous.last_deploy } : {}),
    ...(previous.last_deploy_version
      ? { last_deploy_version: previous.last_deploy_version }
      : {}),
  };
}

async function editRegistry(
  workspaceRoot: string,
  edit: (targets: Record<string, WorkspaceTarget>) => void,
): Promise<void> {
  const files = workspaceFiles(workspaceRoot);
  const text =
    (await readWorkspaceFile(files, WORKSPACE_FILE)) ?? `contract: ${SUPPORTED_CONTRACT}\n`;

  const document = parseDocument(text);
  const raw = (document.toJSON() ?? {}) as {
    workspaces?: Record<string, WorkspaceTarget>;
    targets?: Record<string, LegacyTargetEntry>;
  };

  // **Whichever block this file already keeps its registry in.**
  //
  // This read and wrote `workspaces:` unconditionally. A contract-2 file keeps
  // it under `targets:`, so recording a deploy into one found no registry,
  // added the entry to an empty object, and wrote a *second* block beside the
  // first. `workspaceSchema` has no `targets` key and zod strips what it does
  // not declare, so the hybrid validated and landed.
  //
  // That is reachable from an ordinary command: `deploy` migrates the target
  // workspace, never the local one, so deploying to a bucket from a laptop that
  // has not run `update` yet does exactly this. The result is a file whose two
  // registries disagree — and `rewriteRegistry` then rebuilds `workspaces:`
  // from the stale `targets:`, discarding the newer record without a word.
  //
  // Writing into the block the file already has keeps it coherent at whatever
  // contract it is, and leaves converting the two to the migration that owns
  // that job.
  const legacy = raw.workspaces === undefined && raw.targets !== undefined;
  const block = legacy ? 'targets' : 'workspaces';
  const targets = legacy ? current(raw.targets ?? {}) : (raw.workspaces ?? {});

  edit(targets);

  if (Object.keys(targets).length === 0) document.deleteIn([block]);
  else document.setIn([block], sorted(legacy ? asLegacy(targets) : targets));

  // Validated before it lands, on the rendered tree rather than the input, so
  // what is checked is what would be read back.
  workspaceSchema.parse(document.toJSON());

  await writeWorkspaceFile(files, WORKSPACE_FILE, String(document));
}

function sorted<T>(targets: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(targets).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * A contract-2 entry spelled a pointer `workspace:`; contract 3 spells it `at:`.
 *
 * Normalised on the way in and back on the way out, so `edit` and `pick` see one
 * shape and never have to ask which contract they are looking at — and so a
 * legacy file keeps the spelling its own schema expects.
 */
interface LegacyTargetEntry extends Omit<WorkspaceTarget, 'at'> {
  workspace?: string;
}

function current(targets: Record<string, LegacyTargetEntry>): Record<string, WorkspaceTarget> {
  return Object.fromEntries(
    Object.entries(targets).map(([name, entry]) => {
      const { workspace, ...rest } = entry;
      return [name, workspace === undefined ? rest : { at: workspace, ...rest }];
    }),
  );
}

function asLegacy(targets: Record<string, WorkspaceTarget>): Record<string, LegacyTargetEntry> {
  return Object.fromEntries(
    Object.entries(targets).map(([name, entry]) => {
      const { at, ...rest } = entry;
      return [name, at === undefined ? rest : { workspace: at, ...rest }];
    }),
  );
}
