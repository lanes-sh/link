import { parseDocument } from 'yaml';
import { readWorkspaceFile, workspaceFiles, writeWorkspaceFile } from './files.ts';
import { workspaceSchema, type DeploymentRecord } from './schema.ts';
import { WORKSPACE_FILE, readWorkspace } from './workspace.ts';

/**
 * The workspace's record of where its deployments live.
 *
 * A target is declared by a profile, and that declaration is what every command
 * resolves from. This is the index beside it, and the distinction is the whole
 * design: a profile file rewritten by hand or by a tool took a live Cloud Run
 * service, its bucket, and its credential store out of reach in one edit,
 * because the four lines naming them were the only copy. The service was still
 * running. Nothing could find it.
 *
 * So the record is kept where the thing it describes is not: one level up, in
 * `lanes-link.yaml`. `sync targets` reads it to know which bucket to open, and
 * nothing else reads it at all — an index that starts being resolved from is a
 * second source of truth, which is the failure ADR-037 spent a release
 * removing (ADR-041).
 */

/** Every deployment the workspace has recorded. Empty for a workspace with none. */
export async function readDeployments(workspaceRoot: string): Promise<DeploymentRecord[]> {
  // A workspace file that will not parse is not a reason to fail a recovery:
  // the caller has other ways to find a target, and this is the cheapest.
  try {
    return (await readWorkspace(workspaceRoot))?.deployments ?? [];
  } catch {
    return [];
  }
}

/** What the workspace knows about one target, if anything. */
export async function findDeployment(
  workspaceRoot: string,
  target: string,
): Promise<DeploymentRecord | undefined> {
  return (await readDeployments(workspaceRoot)).find((entry) => entry.target === target);
}

/**
 * Record a deployment, replacing any earlier entry for the same target.
 *
 * Keyed by target rather than appended, because a target has one deployment by
 * definition — a second entry would be a history, and a history is a thing to
 * read wrong. Redeploying the same target to a new bucket should leave one
 * record naming the new one.
 *
 * Merged into the existing entry so a field this caller does not know about —
 * `primary`, on a redeploy that did not ask — is carried forward rather than
 * dropped.
 *
 * Written through the YAML document API, so the comments in a workspace file an
 * operator has annotated survive being indexed.
 */
export async function recordDeployment(
  workspaceRoot: string,
  entry: DeploymentRecord,
): Promise<void> {
  const files = workspaceFiles(workspaceRoot);
  const text = (await readWorkspaceFile(files, WORKSPACE_FILE)) ?? 'contract: 1\n';

  const document = parseDocument(text);
  const existing = await readDeployments(workspaceRoot);
  const previous = existing.find((record) => record.target === entry.target);

  const merged = [
    ...existing.filter((record) => record.target !== entry.target),
    { ...previous, ...entry },
  ].sort((a, b) => a.target.localeCompare(b.target));

  document.setIn(['deployments'], merged);

  // Validated before it lands, on the rendered tree rather than the input, so
  // what is checked is what would be read back.
  workspaceSchema.parse(document.toJSON());

  await writeWorkspaceFile(files, WORKSPACE_FILE, String(document));
}
