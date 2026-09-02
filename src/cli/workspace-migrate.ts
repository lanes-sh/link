import { migrateToContract4, type Contract4Migration } from './contract4.ts';
import { migrateToContract3, needsContract3, type Contract3Migration } from './contract3.ts';
import { readSession } from '#auth/lanes/session.ts';
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
import { C3 } from './contract3-layout.ts';

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
    const text = await readWorkspaceFile(workspaceFiles(workspaceRoot), C3.profile(profile));
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
    // The contract-1 path, frozen. `open` resolves the live layout, which is
    // contract 4's — so this read a profile that does not exist yet and the
    // migration refused a workspace it was supposed to move.
    const document = await ConfigDocument.openKey(workspaceRoot, C3.profile(profile));
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
        : `targets.${name}: declared in ${C3.workspace}`,
    );
  }
  for (const { profile } of legacy) changes.push(`${C3.profile(profile)}: targets: removed, contract: 2`);

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
      C3.profile(profile),
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

export interface ContractMigration {
  readonly workspaceRoot: string;
  /** The contract 1 → 2 half, when this workspace needed one. */
  readonly legacy: WorkspaceMigration | null;
  /** The contract 2 → 3 half, when this workspace needed one. */
  readonly contract3: Contract3Migration | null;
  readonly contract4: Contract4Migration | null;
  /** Every profile either half rewrote, deduplicated. */
  readonly profiles: readonly string[];
  /** Targets written into the registry by the contract 1 → 2 half. */
  readonly targets: readonly { name: string; kind: 'declared' | 'pointer'; where?: string }[];
  /** Both halves' lines, in the order they happened. */
  readonly changes: readonly string[];
  /** Nothing to do: this workspace is already at `SUPPORTED_CONTRACT`. */
  readonly alreadyCurrent: boolean;
}

/**
 * Bring one workspace to `SUPPORTED_CONTRACT`, whatever it is on now.
 *
 * **This exists because "migrate a workspace" was spelled three times and only
 * one of them arrived.** `update` ran the 1→2 step and then the 2→3 step;
 * `deploy` and `doctor --fix` ran the first and stopped, which nothing said out
 * loud — `migrateTargetWorkspace`'s own docstring claimed it brought a target
 * "to the current contract" while calling only `migrateWorkspace`.
 *
 * What that cost is worth writing down, because it is not a refusal. A deploy
 * uploaded contract-3 config over a contract-2 bucket and rolled a revision that
 * read `data/state.kv` and `data/audit.log` — while the bytes sat where contract
 * 2 put them, under `data/<profile>/`. The endpoint came up healthy and answered
 * every call with an empty store: no memory, no tasks, no skills, and an audit
 * log that verified as intact because an empty chain does. Nothing in the
 * deploy, the health probe, or `doctor` had a way to notice.
 *
 * So there is one function now, and the contract number lives in one place. A
 * fourth contract adds a step here and every caller gets it.
 *
 * **A dry run of a contract-1 workspace reports only the first half**, and that
 * is honest rather than a gap: the 1→2 step wrote nothing, so the profiles are
 * still contract 1 and the 2→3 step has nothing it recognises to describe. What
 * it would do is knowable only after the step before it has run.
 *
 * **The signed-in subject is defaulted here rather than by each caller.** A
 * migrated profile that lists nobody is an endpoint that advertises OAuth and
 * then refuses its own owner, so it matters on every path — but `deployments`
 * may not import `#auth` (see `MAY_IMPORT` in `src/architecture.test.ts`), and
 * `deploy` is the caller that most needs it: once a target's profiles live in
 * its bucket there is no upload behind it to put the members row back. A caller
 * that knows better passes one; nobody signed in is a legitimate answer and
 * stays default-deny on the identity axis.
 */
export async function migrateToCurrentContract(
  workspaceRoot: string,
  options: { apply: boolean; subject?: string } = { apply: true },
): Promise<ContractMigration> {
  const legacy = (await needsMigration(workspaceRoot))
    ? await migrateWorkspace(workspaceRoot, { apply: options.apply })
    : null;

  const subject = options.subject ?? (await readSession().catch(() => null))?.subject;

  const contract3 = await migrateToContract3(workspaceRoot, {
    apply: options.apply,
    ...(subject === undefined ? {} : { subject }),
  });

  // In sequence, not in parallel: contract 4 moves what contract 3 produced, so
  // it has to run against the tree the previous step left. With `apply: false`
  // it sees the unmigrated shape and reports only what it can see from here —
  // which is the honest preview, and why the count is not promised.
  const contract4 = await migrateToContract4(workspaceRoot, { apply: options.apply });

  return {
    workspaceRoot,
    legacy: legacy !== null && !legacy.alreadyCurrent ? legacy : null,
    contract3: contract3.alreadyCurrent ? null : contract3,
    contract4: contract4.alreadyCurrent ? null : contract4,
    profiles: [
      ...new Set([...(legacy?.profiles ?? []), ...contract3.profiles, ...contract4.profiles]),
    ],
    targets: legacy?.targets ?? [],
    changes: [...(legacy?.changes ?? []), ...contract3.changes, ...contract4.changes],
    alreadyCurrent:
      (legacy === null || legacy.alreadyCurrent) &&
      contract3.alreadyCurrent &&
      contract4.alreadyCurrent,
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
  const text = (await readWorkspaceFile(files, C3.workspace)) ?? `contract: ${SUPPORTED_CONTRACT}\n`;
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

  await writeWorkspaceFile(files, C3.workspace, String(document));
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
