import { needsContract3 } from './contract3.ts';
import { parseDocument } from 'yaml';
import {
  ConfigError,
  SUPPORTED_CONTRACT,
  WORKSPACE_FILE,
  layout,
  listProfiles,
  readWorkspaceFile,
  isRemoteWorkspace,
  workspaceFiles,
  isLegacyProfile,
  legacyConfigSchema,
  writeWorkspaceFile,
  type LegacyTarget,
  type WorkspaceTarget,
} from '#profile';
import { ConfigDocument } from './config-edit.ts';
import { hoist, summarise } from './migrate-plan.ts';

/**
 * Contract 1 → 2: the target moves out of the profile and into the workspace.
 *
 * Under contract 1 every profile carried a `targets:` block naming the adapter
 * sets it could be opened against. That is what made a deploy leave two copies
 * of each profile — one in `~/.lanes-link`, one in the bucket the endpoint reads
 * — and gave them nothing to keep them honest. It failed the way it was always
 * going to: a local file was rewritten, lost its cloud target and eight
 * connections, and `status --workspace cloud` reported seven where the endpoint was
 * serving fifteen. `sync targets` and ADR-044's deployment index were both
 * written in response to earlier rounds of the same thing.
 *
 * ADR-052 removes the second copy. A workspace *is* a target: it declares its
 * adapters once, in its own `lanes-link.yaml`, and holds the profiles that live
 * in it. This is the one-way trip that gets an existing workspace there.
 *
 * **What it does, per workspace:** hoists each profile's target blocks into the
 * workspace registry, strips `targets:` from the profile, and sets `contract: 2`.
 * A block whose storage names a bucket becomes a *pointer* locally — the bucket
 * declares it — and the adapters travel to that workspace when `deploy` next
 * runs, which is the only command that can put them there safely.
 *
 * **Where it runs** follows `commands/operate/migrate.ts`'s reasoning: an
 * operator should not have to know a migration command exists before their
 * config breaks. So `update` runs it on the local workspace automatically,
 * `doctor --fix` runs it on demand, and `deploy` runs it on the target workspace
 * as its first step — which is what keeps a bucket and the image reading it in
 * step, given contract 1 is not read at all.
 */

export interface WorkspaceMigration {
  readonly workspaceRoot: string;
  /** Profiles rewritten to contract 2. */
  readonly profiles: readonly string[];
  /** Targets written into the registry, and how each was recorded. */
  readonly targets: readonly { name: string; kind: 'declared' | 'pointer'; where?: string }[];
  /** Human-readable lines, in the order they happened. */
  readonly changes: readonly string[];
  /** Nothing to do: every profile was already contract 2. */
  readonly alreadyCurrent: boolean;
}

/** Whether this workspace still holds anything at contract 1. */
export async function needsMigration(workspaceRoot: string): Promise<boolean> {
  for (const profile of await listProfiles(workspaceRoot)) {
    const text = await readWorkspaceFile(workspaceFiles(workspaceRoot), `profiles/${profile}.yaml`);
    if (text === null) continue;
    try {
      if (isLegacyProfile(parseDocument(text).toJSON())) return true;
    } catch {
      // A file that will not parse is not this function's problem to report.
      // `check` gives it a better sentence than "needs migrating" would.
    }
  }
  return false;
}

/**
 * Migrate one workspace. Safe to run on an already-migrated one.
 *
 * **Everything that can fail happens before the first write.** A refusal leaves
 * the workspace exactly as it was rather than half-migrated, which matters more
 * here than usual: the thing being rewritten is the only remaining description
 * of where somebody's accounts live.
 */
export async function migrateWorkspace(
  workspaceRoot: string,
  options: { apply: boolean } = { apply: true },
): Promise<WorkspaceMigration> {
  const names = await listProfiles(workspaceRoot);
  const legacy: { profile: string; document: ConfigDocument; targets: Record<string, LegacyTarget> }[] =
    [];

  for (const profile of names) {
    const document = await ConfigDocument.open(workspaceRoot, profile);
    const raw = document.toJSON();
    if (!isLegacyProfile(raw)) continue;

    const parsed = legacyConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        `${document.path} is contract 1 but its targets: block could not be read, so it cannot ` +
          `be migrated:\n` +
          parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'),
      );
    }

    legacy.push({ profile, document, targets: parsed.data.targets });
  }

  if (legacy.length === 0) {
    return {
      workspaceRoot,
      profiles: [],
      targets: [],
      changes: [],
      alreadyCurrent: true,
    };
  }

  const registry = await hoist(legacy, workspaceRoot);

  const changes: string[] = [];
  for (const [name, entry] of Object.entries(registry)) {
    changes.push(
      entry.at !== undefined
        ? `workspaces.${name}: pointer to ${entry.at}`
        : `targets.${name}: declared in ${WORKSPACE_FILE}`,
    );
  }
  for (const { profile } of legacy) changes.push(`profiles/${profile}.yaml: targets: removed, contract: 2`);

  if (!options.apply) {
    return {
      workspaceRoot,
      profiles: legacy.map((one) => one.profile),
      targets: describe(registry),
      changes,
      alreadyCurrent: false,
    };
  }

  // The registry first. A profile stripped of its targets while the workspace
  // file has not learnt them yet is a profile nothing can open — and that is the
  // window a crash would leave behind. This way round, the worst interruption
  // leaves a workspace that declares its targets *and* profiles that still
  // declare them too, which the next run reconciles by doing the same thing
  // again.
  await writeRegistry(workspaceRoot, registry);

  for (const { document, profile } of legacy) {
    document.removeIn(['targets']);
    // Literally 2, not `SUPPORTED_CONTRACT`. This migration produces a
    // contract-2 profile and nothing else; `migrateToContract3` takes it the
    // rest of the way. Writing the current contract here would stamp a file
    // that still has contract-2 shapes with the newest number, and the loader
    // would then read it as a contract-3 document that is missing `grants:`.
    document.setIn(['contract'], 2);
    // `instance.default_target` went with the block it selected from. It has
    // been inert since ADR-037 and there is now nothing for it to name.
    document.removeIn(['instance', 'default_target']);
    // Written rather than saved, because `save` validates and what this
    // produces is deliberately not valid *yet*: a contract-2 profile, which the
    // runtime does not read. `migrateToContract3` is the step that makes it
    // loadable, and it runs immediately after — so validating here would refuse
    // the only shape this function is able to produce.
    //
    // Nothing is lost by not validating: the next step reads the file it just
    // wrote, and `check` refuses anything either step leaves broken.
    await writeWorkspaceFile(
      workspaceFiles(workspaceRoot),
      `profiles/${profile}.yaml`,
      document.toString(),
    );
  }

  return {
    workspaceRoot,
    profiles: legacy.map((one) => one.profile),
    targets: describe(registry),
    changes,
    alreadyCurrent: false,
  };
}

/**
 * Write the registry into the workspace file, creating it when absent.
 *
 * The whole object is assembled in plain JS and set once. Setting `targets` and
 * then reaching back into it with `setIn(['targets', name, 'primary'])` does not
 * work — the node written from a plain object is not one the document API will
 * traverse — and the failure is a runtime "Expected YAML collection at targets"
 * rather than anything a type would have caught.
 */
async function writeRegistry(
  workspaceRoot: string,
  registry: Record<string, WorkspaceTarget>,
): Promise<void> {
  const files = workspaceFiles(workspaceRoot);
  const text = (await readWorkspaceFile(files, WORKSPACE_FILE)) ?? `contract: ${SUPPORTED_CONTRACT}\n`;
  const document = parseDocument(text);
  const current = (document.toJSON() ?? {}) as {
    workspaces?: Record<string, WorkspaceTarget>;
    deployments?: {
      target?: string;
      workspace?: string;
      primary?: string;
      last_deploy?: string;
    }[];
  };

  // Anything already in the file wins over what was hoisted: a workspace part
  // way through this has entries that are already right, and re-deriving them
  // from a profile that still carries a stale block would undo a correction.
  const merged: Record<string, WorkspaceTarget> = { ...registry, ...(current.workspaces ?? {}) };

  // ADR-044's index, folded into the entries it described. `primary` and
  // `last_deploy` were kept beside the declaration precisely because the
  // declaration could be lost; they belong on it now that it cannot be.
  for (const record of current.deployments ?? []) {
    if (!record.target) continue;
    const entry = merged[record.target];
    if (!entry) continue;
    merged[record.target] = {
      ...entry,
      ...(record.primary ? { primary: record.primary } : {}),
      ...(record.last_deploy ? { last_deploy: record.last_deploy } : {}),
    };
  }

  // `workspaces:`, not `targets:` — the registry is read back by the current
  // schema even while the profiles beside it are still contract 2, because it
  // is one document that both migrations share (ADR-061). The profiles are the
  // half that stays at 2 until `migrateToContract3` runs.
  document.setIn(['contract'], SUPPORTED_CONTRACT);
  document.setIn(
    ['workspaces'],
    Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))),
  );
  document.deleteIn(['targets']);
  document.deleteIn(['deployments']);
  document.deleteIn(['default_target']);

  await writeWorkspaceFile(files, WORKSPACE_FILE, String(document));
}

function describe(
  registry: Record<string, WorkspaceTarget>,
): { name: string; kind: 'declared' | 'pointer'; where?: string }[] {
  return Object.entries(registry).map(([name, entry]) =>
    entry.at !== undefined
      ? { name, kind: 'pointer' as const, where: entry.at }
      : { name, kind: 'declared' as const },
  );
}

/**
 * Refuse a contract-1 workspace with the command that fixes it.
 *
 * `readRegistry` answers `{}` for one, because the `targets:` block it reads did
 * not exist until contract 2 — so without this every command refuses with "this
 * workspace declares no targets", which is a true sentence pointing in exactly
 * the wrong direction.
 *
 * `update` is named rather than `doctor --fix`, and that is not arbitrary:
 * `doctor` needs a `--target`, and on an unmigrated workspace there is no target
 * to give it. `update` takes neither flag and migrates the local workspace as
 * part of what it already means (ADR-052).
 */
export async function refuseIfUnmigrated(root: string): Promise<void> {
  if (await needsContract3(root)) {
    throw new ConfigError(
      `${root} is a contract 2 workspace, and this version does not read one.\n\n` +
        '  Under contract 2 each profile carried its own connections and one flat\n' +
        '  policy. Connections belong to the workspace now, and a profile selects\n' +
        '  among them with per-connection scopes (ADR-057, ADR-058).\n\n' +
        '  Migrate it:  lanes link update\n' +
        '  Preview it:  lanes link update --check\n\n' +
        '  Nothing is deleted by the migration: credentials are merged and read back\n' +
        '  before the old stores are left in place.',
    );
  }

  if (!(await needsMigration(root))) return;

  throw new ConfigError(
    `${root} is a contract 1 workspace, and this version does not read one.\n\n` +
      '  Under contract 1 each profile declared its own targets. They are declared\n' +
      '  once by the workspace now, which is what stopped a deploy leaving two\n' +
      '  copies of every profile that could drift apart (ADR-052).\n\n' +
      '  Migrate it:  lanes link update\n' +
      '  A deployed target is migrated by the deploy that ships the image reading it:\n' +
      '               lanes link deploy --workspace <name>',
  );
}
