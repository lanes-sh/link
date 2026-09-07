import { renderOutcome } from './remove-render.ts';

// Re-exported so a caller importing the command also gets its renderer, which
// is where both lived before the split.
export { renderOutcome } from './remove-render.ts';
import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import {
  ConfigError,
  WORKSPACE_FILE,
  openTarget,
  readWorkspace,
  readWorkspaceFile,
  workspaceFiles,
  workspacePath,
  writeWorkspaceFile,
} from '#profile';
import { parseDocument } from 'yaml';
import { rm } from 'node:fs/promises';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { confirmedByName } from './confirm.ts';
import { recordConfigChange } from '../../audit-change.ts';
import { nextAfterEdit, publishProfileEdit } from '../../publish.ts';
import { announceProfile, emit, fail, ok, print, style } from '../../output.ts';
import {
  buildRegistryWithWorkspace,
  openBlobStoreFor,
  openSecretStoreFor,
  resolveProfileOnly,
  type GlobalFlags,
} from '../../runtime.ts';
import { loadWorkspaceProfiles } from '#profile';
import { removalPlan, renderPlan, type RemovalItem, type RemovalPlan } from './removal.ts';
import { settleDisposition, type Disposition } from './disposition.ts';

/**
 * Performing a removal, and being honest about the parts that did not happen.
 *
 * Best effort by choice: a target whose project has been deleted must not be
 * able to strand a profile on the machine forever, so one refusal does not stop
 * the rest. The price is real — a deletion that fails leaves a live credential
 * behind — and everything here exists to make that visible rather than quiet.
 */

export interface RemovalResult {
  readonly item: RemovalItem;
  /** `kept` is deliberate: not attempted, because something before it failed. */
  readonly status: 'removed' | 'failed' | 'kept';
  readonly error?: string;
  /** The exact command that finishes this one by hand. */
  readonly retry?: string;
}

export interface RemovalOutcome {
  readonly profile: string;
  readonly results: readonly RemovalResult[];
  /** How many items are still there. Non-zero means a credential is still live. */
  readonly survived: number;
}

export interface RunDeps {
  openSecrets: (target: string) => Promise<SecretStore>;
  openBlobs: (target: string, area?: string) => Promise<BlobStore>;
  removeConfig: (path: string) => Promise<void>;
  /** The emptied profile directory. A blob delete cannot remove a directory. */
  removeDirectory: (path: string) => Promise<void>;
  clearDefaultProfile: () => Promise<void>;
  retry?: ((item: RemovalItem, cause: string) => string | undefined) | undefined;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The items that only make sense once everything else is actually gone.
 *
 * **`file` is in here, and that is the whole of its reason.** It is
 * `rm -rf profiles/<profile>`, and it carries a target rather than `null`, so
 * the original `target === null` test let it run after a failed object — taking
 * the bytes a `--migrate-to` had not managed to copy, and `profile.yaml`, which
 * the sweep deliberately leaves for last. `renderOutcome` then printed "the
 * profile's config was kept, so nothing is stranded" about a directory that no
 * longer existed. Same shape as the defect this file records having shipped
 * once already.
 */
const isRecordOfWhereThingsAre = (item: RemovalItem): boolean =>
  item.kind === 'file' ||
  (item.target === null && (item.kind === 'config' || item.kind === 'workspace-key'));

export async function executeRemoval(
  plan: RemovalPlan,
  deps: RunDeps,
): Promise<RemovalOutcome> {
  const results: RemovalResult[] = [];
  let failed = 0;

  // One store per target, however many items it holds. Opening a Secret
  // Manager client per secret would turn a tidy removal into a rate limit.
  const secrets = new Map<string, Promise<SecretStore>>();
  const blobs = new Map<string, Promise<BlobStore>>();

  const secretStore = (target: string): Promise<SecretStore> => {
    const existing = secrets.get(target) ?? deps.openSecrets(target);
    secrets.set(target, existing);
    return existing;
  };

  const blobStore = (target: string, area?: string): Promise<BlobStore> => {
    const key = `${target}:${area ?? ''}`;
    const existing = blobs.get(key) ?? deps.openBlobs(target, area);
    blobs.set(key, existing);
    return existing;
  };

  for (const item of plan.items) {
    // The config is the only record of where everything else lives. Deleting it
    // after a failure would strand precisely the credential that failed: still
    // live, and nothing left that knows where it is. Keeping it means the retry
    // is this same command rather than a hand-assembled console session.
    if (failed > 0 && isRecordOfWhereThingsAre(item)) {
      results.push({ item, status: 'kept' });
      continue;
    }

    try {
      switch (item.kind) {
        case 'secret':
          await (await secretStore(item.target!)).delete(item.id);
          break;

        case 'blob': {
          const store = await blobStore(item.target!, item.area);

          // Read across *before* deleting, and verify it landed — the same rule
          // the contract migrations follow, for the same reason: a copy that
          // half happened and a source that is already gone is the one state
          // with nothing to retry from. A collision was resolved while this was
          // still a plan, so the destination is free.
          if (item.movedTo !== undefined) {
            const [area, key] = item.movedTo;
            const bytes = await store.get(item.id);

            if (bytes !== null) {
              const into = await blobStore(item.target!, area);
              await into.put(key, bytes);
              if ((await into.get(key)) === null) {
                throw new Error(`${area}/${key} did not read back after being written`);
              }
            }
          }

          await store.delete(item.id);
          break;
        }

        case 'config':
          if (item.target === null) await deps.removeConfig(item.id);
          else {
            // `profiles/<name>.yaml` in the target's bucket — outside the
            // profile's blob tree, so it needs its own area.
            const [area, ...rest] = item.id.split('/');
            await (await blobStore(item.target, area)).delete(rest.join('/'));
          }
          break;

        case 'workspace-key':
          await deps.clearDefaultProfile();
          break;

        case 'file':
          await deps.removeDirectory(item.id);
          break;
      }

      results.push({ item, status: 'removed' });
    } catch (cause) {
      const error = reason(cause);
      const retry = deps.retry?.(item, error);
      failed += 1;
      results.push({ item, status: 'failed', error, ...(retry ? { retry } : {}) });
    }
  }

  return {
    profile: plan.profile,
    results,
    survived: results.filter((result) => result.status !== 'removed').length,
  };
}

export interface RemoveFlags extends GlobalFlags {
  readonly dryRun?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly json?: boolean | undefined;
  /** Delete this profile's memory, tasks, assets, entities, vault and skills. */
  readonly deleteData?: boolean | undefined;
  /** Move them into this profile instead. */
  readonly migrateTo?: string | undefined;
  /** Injected by a caller that has already asked — the console, and tests. */
  readonly prompter?: Prompter | undefined;
}


/**
 * `lanes link profile remove <name>` — the profile, and everything it owns.
 *
 * Deliberately not reachable from MCP. This writes credentials and mutates
 * config, which ADR-007 keeps CLI-only, and it is the most destructive thing
 * in the tool.
 */
export async function removeProfile(
  name: string,
  flags: RemoveFlags,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<RemovalOutcome | null> {
  const { selection, config, target } = await resolveProfileOnly(
    { ...flags, profile: name },
    options.env !== undefined ? { env: options.env } : {},
  );
  announceProfile(selection);

  const root = selection.workspaceRoot;
  const registry = await buildRegistryWithWorkspace(root);
  const files = workspaceFiles(root);
  const { declared } = await openTarget(root, target);

  const prompter = flags.prompter ?? terminalPrompter;
  const someoneToAsk = flags.prompter ? prompter.interactive : process.stdin.isTTY;
  const disposition = await settleDisposition(name, flags, prompter, someoneToAsk);

  if (disposition === null) {
    print(style.dim('  cancelled — nothing was removed'));
    return null;
  }

  if (disposition.kind === 'migrate') {
    // Before the plan, because a plan against a profile that does not exist
    // would name destinations nothing will ever read.
    const staying = (await loadWorkspaceProfiles(root)).loaded.map((one) => one.profile);
    if (disposition.into === name || !staying.includes(disposition.into)) {
      throw new ConfigError(
        `Cannot migrate "${name}" into "${disposition.into}".\n` +
          `  Staying: ${staying.filter((one) => one !== name).join(', ') || 'nothing'}`,
      );
    }
  }

  const plan = await removalPlan(config, root, name, registry, {
    target,
    declared,
    disposition,
    openSecrets: (target) => openSecretStoreFor(root, target),
    openBlobs: (target, area) => openBlobStoreFor(config, root, target, area),
    readDefaultProfile: async () => (await readWorkspace(root))?.default_profile,
    // What the workspace keeps. The credential store is one file for all of
    // them now, so anything a survivor declares is not this removal's to delete.
    survivors: (await loadWorkspaceProfiles(root)).loaded
      .filter((one) => one.profile !== name)
      .map((one) => one.config),
  });

  renderPlan(plan);

  if (flags.dryRun) {
    print(style.dim('  --dry-run: nothing was removed, and no store was written to.'));
    print();
    emit(flags.json, plan, () => {});
    return null;
  }

  if (!(await confirmedByName(name, { yes: flags.yes, prompter: flags.prompter }))) return null;

  const outcome = await executeRemoval(plan, {
    openSecrets: (target) => openSecretStoreFor(root, target),
    openBlobs: (target, area) => openBlobStoreFor(config, root, target, area),
    removeConfig: async (path) => await files.delete(relativeToRoot(root, path)),
    removeDirectory: async (path) => await rm(workspacePath(root, path), { recursive: true, force: true }),
    clearDefaultProfile: async () => await clearDefault(root),
    retry: retryCommand,
  });

  // Before the render, and against the config loaded above — the profile's file
  // is gone by now, so a helper that re-read it would find nothing.
  await recordConfigChange(config, root, target, {
    capability: 'config.profile.remove',
    scope: name,
    arguments: { connections: config.grants.map((grant) => grant.connection) },
  });

  // And the endpoint is told, as it is told about every other config edit
  // (ADR-074) — but more urgently than any of them. It holds the profiles it
  // listed at boot, so without this a profile that has been *removed*, with its
  // credentials and its stores deleted, stayed reachable until the revision
  // happened to restart: the operator believing they had revoked something they
  // had not. Wrapped because the removal has already happened and a failure to
  // announce it cannot undo it; `publishWorkspace` copies what the local store
  // has, which no longer includes this profile, so nothing here can put the
  // file back. A throw is reported as nothing — `renderOutcome` owns the exit
  // code, derived from what survived on the stores.
  let published: string | undefined;
  try {
    const resolution = { workspaceRoot: root, profile: name };
    published = nextAfterEdit(await publishProfileEdit({ resolution, config, target }));
  } catch {
    // See above.
  }

  // Returned as well as rendered, so a caller that is not a terminal can read
  // `survived` — the difference between removed and half-removed. `emit`
  // answers `void`, so the value has to be built here and handed back; the
  // control plane reports a survivor as a failure and cannot see one otherwise.
  const answer = { ...outcome, ...(published ? { published } : {}) };
  await emit(flags.json, answer, () => {
    renderOutcome(outcome);
    if (published) print(style.dim(`  ${published}`));
  });
  return answer;
}

/** `profiles/<name>.yaml`, however the path was spelled for display. */
function relativeToRoot(root: string, path: string): string {
  const at = path.indexOf('profiles/');
  return at === -1 ? path.replace(`${root}/`, '') : path.slice(at);
}

/**
 * Clear the key, never repoint it.
 *
 * Choosing a new default on the operator's behalf would silently change what
 * every other command in that workspace acts on — the one thing a removal
 * should not decide for them.
 */
async function clearDefault(root: string): Promise<void> {
  const text = await readWorkspaceFile(workspaceFiles(root), WORKSPACE_FILE);
  if (text === null) return;

  const document = parseDocument(text);
  document.delete('default_profile');
  await writeWorkspaceFile(workspaceFiles(root), WORKSPACE_FILE, String(document));
}

/** The command that finishes a refusal by hand, where one can be named. */
function retryCommand(item: RemovalItem): string | undefined {
  if (item.kind !== 'secret') return undefined;
  return `lanes link profile remove <name> --target ${item.target} # or delete ${item.id} in that store`;
}
