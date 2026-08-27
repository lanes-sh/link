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
    // A pointer replacing a declaration is `deploy` handing the target over to
    // the workspace it just wrote, so the adapter keys have to go rather than
    // merge — an entry carrying both is what the schema refuses.
    targets[target] =
      entry.workspace !== undefined ? { ...pick(previous), ...entry } : { ...previous, ...entry };
  });
}

/** Forget a target. Used by `profile remove --target` once nothing is left in it. */
export async function removeTarget(workspaceRoot: string, target: string): Promise<void> {
  await editRegistry(workspaceRoot, (targets) => {
    delete targets[target];
  });
}

/** The fields that survive a declaration becoming a pointer: the deploy record. */
function pick(previous: WorkspaceTarget | undefined): Partial<WorkspaceTarget> {
  if (!previous) return {};
  return {
    ...(previous.primary ? { primary: previous.primary } : {}),
    ...(previous.last_deploy ? { last_deploy: previous.last_deploy } : {}),
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
  const targets = (document.toJSON()?.targets ?? {}) as Record<string, WorkspaceTarget>;

  edit(targets);

  if (Object.keys(targets).length === 0) document.deleteIn(['targets']);
  else document.setIn(['targets'], sorted(targets));

  // Validated before it lands, on the rendered tree rather than the input, so
  // what is checked is what would be read back.
  workspaceSchema.parse(document.toJSON());

  await writeWorkspaceFile(files, WORKSPACE_FILE, String(document));
}

function sorted(targets: Record<string, WorkspaceTarget>): Record<string, WorkspaceTarget> {
  return Object.fromEntries(Object.entries(targets).sort(([a], [b]) => a.localeCompare(b)));
}
