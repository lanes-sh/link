import { CONNECTIONS_FILE, listProfiles, workspaceFiles, writeWorkspaceFile } from '#profile';
import { newConnectionsTemplate } from './config-templates.ts';
import { ConfigDocument } from './config-edit.ts';
import { ok, print, style, warn } from './output.ts';
import { DEFAULT_SURFACES, ensureOwnerLayer, repairLines, repaired } from './config-repair.ts';

/**
 * Applying the owner-layer repair across a whole workspace.
 *
 * Split from `config-repair.ts` when that file outgrew the budget, on the seam
 * it already had: that file decides what one profile is missing, and this one
 * walks the workspace applying it. The decision is a pure function of two
 * documents and is tested as one; the sweep is all filesystem, ordering and
 * what to say when a profile will not open.
 */

/** `memory, tasks, assets, skills, vault, setup and entities`, in repair order. */
function listSurfaces(): string {
  const names = [...DEFAULT_SURFACES];
  const last = names.pop();
  return names.length === 0 ? String(last) : `${names.join(', ')} and ${last}`;
}

/** The workspace's connections document, written from the template if missing. */
async function openOrCreateConnections(workspaceRoot: string): Promise<ConfigDocument> {
  try {
    return await ConfigDocument.openKey(workspaceRoot, CONNECTIONS_FILE);
  } catch {
    await writeWorkspaceFile(
      workspaceFiles(workspaceRoot),
      CONNECTIONS_FILE,
      newConnectionsTemplate(),
    );
    return ConfigDocument.openKey(workspaceRoot, CONNECTIONS_FILE);
  }
}

/**
 * Apply that repair across a workspace, saving and reporting what changed.
 *
 * Here rather than in `#deployments`, where it was, because `start` needs it as
 * much as `deploy` does — more, in fact: `start` is the one command an existing
 * install runs without being asked to, so it is the path by which a profile
 * written before ADR-050 gets the layer at all. Two copies of a function that
 * widens a policy is not a thing to have.
 *
 * **The caller scopes it**, and for `deploy` that is exactly the set being
 * uploaded: a profile it sends is a profile the endpoint will serve, so
 * repairing a narrower set would leave a served profile without the surfaces.
 * Note what a `--profile` flag does not mean — it is the flag alone, so a
 * profile resolved from the environment leaves it undefined and that reads as
 * the whole workspace.
 *
 * *Which files are profiles* comes from `listProfiles`, never from an allowlist
 * of what is safe to copy: that would happily hand over a committed
 * `personal.example.yaml` or a nested `profiles/archive/old.yaml`, and this
 * opens and validates what it is given — which once turned a template into a
 * `ConfigError` aborting a deploy after provisioning had made cloud resources.
 *
 * A profile that cannot be read is warned about rather than fatal: the repair is
 * a courtesy on the way past, and the caller's real work should still happen.
 * Not silent, though — nothing else widens a policy without being asked.
 *
 * CLI-side by construction, like everything else in this file: a deployed
 * revision holds `objectViewer` on `profiles/` (ADR-023) and could not write
 * this even if the code let it.
 */
export async function repairOwnerLayer(
  workspaceRoot: string,
  profiles: readonly string[] | undefined,
  options: { report?: (line: string) => void } = {},
): Promise<void> {
  // stdout by default, because every caller but one is printing a report a
  // person reads. `update --json` passes `progress` instead: what it produces is
  // a document, and a line of prose in front of it corrupts whatever is parsing.
  // Routed rather than silenced — nothing else here widens a policy without
  // saying so, and this must not be the exception.
  const say = options.report ?? print;
  const wanted = profiles === undefined ? undefined : new Set(profiles);

  // One connections document for the whole sweep. The owner layer is the
  // workspace's now (ADR-059), so repairing three profiles must not add three
  // `memory.main` rows — opening it once and saving it once is what makes the
  // second profile see what the first one created.
  // Created if absent rather than refused. A contract-3 workspace always has
  // one, but a hand-made or half-migrated one may not — and this is the repair,
  // so the file it needs is a thing to write rather than a reason to stop.
  const connections = await openOrCreateConnections(workspaceRoot);
  let connectionsChanged = false;

  for (const name of await listProfiles(workspaceRoot)) {
    if (wanted !== undefined && !wanted.has(name)) continue;

    try {
      const document = await ConfigDocument.open(workspaceRoot, name);
      const repair = ensureOwnerLayer(connections, document);
      if (!repaired(repair)) continue;

      connectionsChanged = true;
      await document.save();

      say(ok(`gave ${style.bold(name)} its own owner layer`));
      for (const change of repairLines(repair)) say(`      ${style.dim(change)}`);
      // Built from `DEFAULT_SURFACES` rather than typed out. The typed-out
      // version still named six after a seventh had been added, so a person
      // watching a deploy was told entities had arrived on the line above and
      // that the layer was six things on the line below.
      say(`      ${style.dim(`${listSurfaces()} — your own material, no account behind any of them`)}`);
    } catch (error) {
      say(
        warn(
          `could not give ${name} its owner layer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        ),
      );
    }
  }

  if (connectionsChanged) await connections.save();
}
