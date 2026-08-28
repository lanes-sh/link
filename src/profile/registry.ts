import { ConfigError } from './load.ts';
import { notInRegistry } from './targets.ts';
import { readWorkspace } from './workspace.ts';
import {
  SUPPORTED_CONTRACT,
  declaredTarget,
  isPointer,
  type TargetConfig,
  type WorkspaceTarget,
} from './schema.ts';

/**
 * The target registry: which targets exist, and which workspace declares each.
 *
 * A target names an adapter set. Under contract 1 a *profile* declared one per
 * target it could be opened against, which is what made a deploy leave two
 * copies of every profile — one in `~/.lanes-link`, one in the bucket the
 * endpoint reads — with nothing keeping them honest. The reported failure is in
 * `sync-apply.ts`'s header and it happened again while this was being written:
 * a rewritten local file reported seven connections for a target whose bucket
 * held fifteen, and the endpoint went on serving all fifteen throughout.
 *
 * Now a workspace **is** a target (ADR-052). It declares its adapters once, in
 * its own `lanes-link.yaml`, and holds the profiles that live in it. A profile
 * is one copy in one place, so there is no reconciliation left to get wrong.
 *
 * A machine reaches a target it does not hold through a **pointer** — a registry
 * entry carrying `workspace:` and nothing else. Following one is a read of that
 * workspace's own file, which is why every function here is async and why
 * `--target cloud` needs the bucket reachable. That is the trade ADR-052 takes
 * deliberately: a cloud target that cannot be read says so, where the shape it
 * replaces answered instantly from a copy that had been wrong for eight hours.
 */

/** Everything a command needs once it knows which target it is acting on. */
export interface ResolvedTarget {
  readonly target: string;
  /**
   * Where this target's profiles and workspace file live — a directory, or a
   * bucket URL. Not necessarily the root the command was invoked from.
   */
  readonly workspaceRoot: string;
  /** The adapter set, from whichever workspace declares it. */
  readonly declared: TargetConfig;
  /** The declaring entry, for `primary` and the deploy record. */
  readonly entry: WorkspaceTarget;
  /** Whether the local workspace reached this through a pointer. */
  readonly remote: boolean;
}

/** Every target the workspace at `root` knows about. Empty when it has no file. */
export async function readRegistry(root: string): Promise<Record<string, WorkspaceTarget>> {
  const workspace = await readWorkspace(root);
  return workspace?.targets ?? {};
}

/**
 * Follow a target to the workspace that declares it.
 *
 * Returns `root` itself for a target this workspace declares, and the pointer's
 * URI for one it does not. One hop only: a pointer whose destination is itself a
 * pointer is a loop, and a registry that can chain is one where "where does this
 * live" stops having a short answer.
 */
export async function resolveTargetWorkspace(root: string, target: string): Promise<string> {
  const registry = await readRegistry(root);
  const entry = registry[target];
  if (!entry) throw notInRegistry(target, registry, root);
  return isPointer(entry) ? entry.workspace.replace(/\/$/, '') : root;
}

/**
 * A target, resolved to the adapter set a command can open.
 *
 * The pointer hop is the only thing here that touches the network, and it
 * happens once per command rather than per store — `openSecretStoreFor` and
 * `openBlobStoreFor` take what this returns rather than resolving again.
 */
export async function openTarget(root: string, target: string): Promise<ResolvedTarget> {
  const registry = await readRegistry(root);
  const entry = registry[target];
  if (!entry) throw notInRegistry(target, registry, root);

  if (!isPointer(entry)) {
    const declared = declaredTarget(entry);
    // Unreachable through the schema, which refuses an entry that is neither a
    // pointer nor a complete declaration. Kept because the alternative to a
    // sentence here is a `TypeError` inside an adapter three frames down.
    if (!declared) throw incompleteTarget(target, root);
    return { target, workspaceRoot: root, declared, entry, remote: false };
  }

  const workspaceRoot = entry.workspace.replace(/\/$/, '');
  const remoteRegistry = await readRegistry(workspaceRoot);
  const remoteEntry = remoteRegistry[target];

  if (!remoteEntry) {
    // A contract-1 workspace has no `targets:` block at all, so it looks exactly
    // like one that declares the wrong things. Told apart here because the two
    // have completely different fixes, and "does not declare it" would send
    // someone editing a bucket that is merely out of date.
    if (await isUnmigrated(workspaceRoot)) throw remoteAtContractOne(target, workspaceRoot);
    throw pointerMissesTarget(target, workspaceRoot, remoteRegistry, root);
  }
  if (isPointer(remoteEntry)) throw pointerChain(target, workspaceRoot, root);

  const declared = declaredTarget(remoteEntry);
  if (!declared) throw incompleteTarget(target, workspaceRoot);

  // The local entry's `primary`, `last_deploy` and `last_deploy_version` are what
  // `deploy` wrote on the machine that ran it; the declaring workspace is
  // authoritative for everything else. Merged this way round so a redeploy from a
  // second machine does not silently lose the first one's record of who opens the
  // endpoint.
  return {
    target,
    workspaceRoot,
    declared,
    entry: { ...entry, ...remoteEntry },
    remote: true,
  };
}

/** The targets a workspace declares itself, rather than pointing at. */
export function declaredHere(registry: Record<string, WorkspaceTarget>): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => !isPointer(entry))
    .map(([name]) => name)
    .sort();
}

function incompleteTarget(target: string, root: string): ConfigError {
  return new ConfigError(
    `Target "${target}" in ${root} declares neither "credentials" nor "storage", ` +
      'so there is nothing to open.',
  );
}

function pointerMissesTarget(
  target: string,
  workspaceRoot: string,
  remote: Record<string, WorkspaceTarget>,
  root: string,
): ConfigError {
  const there = Object.keys(remote).sort().join(', ') || 'none';
  return new ConfigError(
    `${root} says target "${target}" lives at ${workspaceRoot}, but that workspace does not ` +
      `declare it (it declares: ${there}).\n` +
      `  Adopt what is really there:  lanes link sync targets --target ${target} --from ${workspaceRoot}`,
  );
}

function pointerChain(target: string, workspaceRoot: string, root: string): ConfigError {
  return new ConfigError(
    `${root} points target "${target}" at ${workspaceRoot}, which points somewhere else again.\n` +
      '  A target is declared by exactly one workspace. Follow it and declare it there.',
  );
}


/**
 * Whether a workspace still holds contract-1 profiles.
 *
 * Duplicated in spirit with `workspace-migrate.ts`'s `needsMigration`, and not
 * imported from it: `#profile` is below `#cli` in the layering, and a refusal
 * reaching upwards for a sentence is how a cycle gets introduced. This looks at
 * one file rather than every profile, which is all a refusal needs.
 */
async function isUnmigrated(root: string): Promise<boolean> {
  const workspace = await readWorkspace(root).catch(() => null);
  if (workspace === null) return false;
  return workspace.contract < SUPPORTED_CONTRACT;
}

function remoteAtContractOne(target: string, workspaceRoot: string): ConfigError {
  return new ConfigError(
    `${workspaceRoot} is a contract 1 workspace, so it does not declare "${target}" yet.\n` +
      '  Its profiles still carry their own targets: block, which this version does not read.\n\n' +
      `  lanes link deploy --target ${target}\n` +
      '  migrates it and rolls the image that can read it, in that order — which is what\n' +
      '  keeps the endpoint in front of it serving throughout (ADR-052).',
  );
}
