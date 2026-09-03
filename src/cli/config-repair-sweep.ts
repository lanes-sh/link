import {
  CONNECTIONS_FILE,
  listProfiles,
  SUPPORTED_CONTRACT,
  WORKSPACE_FILE,
  workspaceFiles,
  writeWorkspaceFile,
} from '#profile';
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

/**
 * Stamp the registry with the contract the workspace is actually in.
 *
 * `renameRegistry` copies `lanes-link.yaml` to `workspaces.yaml` byte for byte,
 * which is what makes an interruption survivable — but it carried the old
 * `contract:` across with everything else, so a migrated workspace sat at 3
 * while every profile in it said 4, and a workspace `profile add` created said
 * 4 from the start. Two workspaces at the same contract disagreeing about which
 * one they are in.
 *
 * Cosmetic in most commands, which read the profiles. Not in `isUnmigrated`
 * (`src/profile/registry.ts`), the one place a registry's own contract is read:
 * it compares against `SUPPORTED_CONTRACT` to tell a pointer at an out-of-date
 * bucket from a pointer at the wrong target, so a stale stamp there answers a
 * question about contract 4 with a refusal naming *contract 1* and sends the
 * operator to a `deploy` that changes nothing.
 *
 * Called from the migration, so its output needs no repair, and from the sweep,
 * for the workspaces 0.9.0 already migrated. One spelling, for the reason the
 * template and `ensureOwnerLayer` share one: two would have to agree forever.
 */
export async function ensureRegistryContract(
  workspaceRoot: string,
  /**
   * The contract to stamp, which is the one the caller is *producing*.
   *
   * Defaulted to the newest for the repair sweep, and passed explicitly by each
   * migration step. A step that stamped the newest would put the registry ahead
   * of the profiles it just wrote — and `isUnmigrated` reads exactly this field,
   * so the registry would report the workspace as migrated with a later step
   * still to run. That is the same defect the note on
   * `the contract it stamps on the registry` describes, in the direction that
   * fails silently rather than loudly.
   */
  contract: number = SUPPORTED_CONTRACT,
): Promise<boolean> {
  const files = workspaceFiles(workspaceRoot);
  if (!(await files.has(WORKSPACE_FILE))) return false;

  const document = await ConfigDocument.openKey(workspaceRoot, WORKSPACE_FILE);
  if (document.getIn(['contract']) === contract) return false;

  document.setIn(['contract'], contract);
  await document.save();
  return true;
}

/**
 * The first line of an error that actually says something.
 *
 * `message.split('\n')[0]` was the whole of this, and a `ConfigError` from a
 * schema failure is `<path>:\n  <field>: <reason>` — so the warning rendered as
 * "could not give personal its owner layer: /…/personal.yaml:" and named no
 * reason at all. Seen for real on an upgrade, twice, with nothing after the
 * colon.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const lines = error.message.split('\n').map((line) => line.trim());
  const said = lines.find((line) => line !== '' && !line.endsWith(':'));
  return said ?? lines.find((line) => line !== '') ?? error.message;
}

/** `memory, tasks, assets, skills, vault, setup and entities`, in repair order. */
function listSurfaces(): string {
  const names = [...DEFAULT_SURFACES];
  const last = names.pop();
  return names.length === 0 ? String(last) : `${names.join(', ')} and ${last}`;
}

/** The workspace's connections document, written from the template if missing. */
export async function openOrCreateConnections(workspaceRoot: string): Promise<ConfigDocument> {
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
          `could not give ${name} its owner layer: ${reasonOf(error)}`,
        ),
      );
    }
  }

  if (connectionsChanged) await connections.save();

  // After the profiles, so a workspace that could not be repaired is not told
  // it is current. The stamp says what the workspace is; the profiles are what
  // makes it true.
  if (await ensureRegistryContract(workspaceRoot)) {
    say(ok(`stamped ${style.bold(WORKSPACE_FILE)} as contract ${SUPPORTED_CONTRACT}`));
  }
}
