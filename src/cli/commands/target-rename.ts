import { ConfigError, MANAGED_TARGET, WORKSPACE_FILE, resolveWorkspaceRoot } from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { emit, ok, print, style } from '../output.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link workspace rename <old> <new>` — one target, under a better name.
 *
 * A target name is a local label. `cloud` was only ever the example in the docs,
 * and a name that says *what a thing is* — `self-hosted-acme` — is worth having
 * on the flag somebody types every day.
 *
 * Under ADR-052 a target is declared once, in the workspace registry, and a
 * profile no longer carries a `targets:` block. So this rewrites one key, plus
 * any pointer whose `at:` names it — the whole of the consistency this owes.
 * That is smaller than it would have been under contract 1, and the reason is
 * worth knowing before somebody adds a second place to record a target name.
 */

export interface RenameFlags extends GlobalFlags {
  readonly json?: boolean;
}

/**
 * Why `managed` may not move, in either direction.
 *
 * It is not a name the operator chose. The managed control routes resolve it by
 * name: an assertion carries a workspace, `workspaceRootFor` derives
 * `lanes://<workspace>` from it, and the writers then look this key up in that
 * workspace's registry. Rename it and the lookup misses — so **every control
 * call starts failing while the CLI still looks perfectly healthy**, which is
 * the shape of break that costs an afternoon to find.
 *
 * Refused as the *new* name too: moving some other target onto the reserved key
 * collides with the real one and gets there by a different road.
 */
function refuseManaged(old: string, next: string): void {
  const which = old === MANAGED_TARGET ? old : next === MANAGED_TARGET ? next : null;
  if (which === null) return;

  throw new ConfigError(
    `"${MANAGED_TARGET}" is not a name you can change — it is scoped to the workspace, ` +
      'and the managed control surface looks it up by exactly this key.\n' +
      '\n' +
      '  To rename the workspace itself, do it in the dashboard:\n' +
      '    https://lanes.sh/dashboard\n' +
      '\n' +
      '  That changes the name people see. The target key stays as it is, which is\n' +
      '  what keeps a managed workspace reachable.',
  );
}

export interface RenamedTarget {
  readonly from: string;
  readonly to: string;
  /** Pointers repointed at the new name, if any. */
  readonly repointed: readonly string[];
}

/** The data function. `targetRename` below is the printing wrapper. */
export async function renameTarget(
  from: string,
  to: string,
  options: { root?: string } = {},
): Promise<RenamedTarget> {
  refuseManaged(from, to);

  if (from === to) {
    throw new ConfigError(`"${from}" is already its name.`);
  }
  // The key becomes a path segment and a flag value, so the same rule the rest
  // of the registry assumes applies here rather than being discovered later by
  // a shell that split it.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(to)) {
    throw new ConfigError(
      `"${to}" is not a usable target name. Use letters, digits, ".", "-" and "_".`,
    );
  }

  const root = options.root ?? resolveWorkspaceRoot();
  const document = await ConfigDocument.openKey(root, WORKSPACE_FILE);
  const registry = (document.toJSON() ?? {}) as {
    workspaces?: Record<string, { at?: string }>;
  };
  const workspaces = registry.workspaces ?? {};

  if (workspaces[from] === undefined) {
    throw new ConfigError(
      `This workspace declares no target called "${from}".\n` +
        `  Declared: ${Object.keys(workspaces).join(', ') || '(none)'}`,
    );
  }
  if (workspaces[to] !== undefined) {
    // Refused rather than merged. Two targets are two adapter sets, and the
    // one that lost would take its bucket and its credentials with it.
    throw new ConfigError(`This workspace already declares a target called "${to}".`);
  }

  // Read the entry before it moves, so the write below is a set-then-remove
  // rather than a rename the document API does not offer.
  const entry = document.getIn(['workspaces', from]);
  document.setIn(['workspaces', to], entry);
  document.removeIn(['workspaces', from]);

  // A pointer names its target by string, so one left behind points at a key
  // that no longer exists — and `resolveTargetWorkspace` would report it as a
  // missing target rather than as a rename that finished halfway.
  const repointed: string[] = [];
  for (const [name, value] of Object.entries(workspaces)) {
    if (name === from || value?.at !== from) continue;
    document.setIn(['workspaces', name, 'at'], to);
    repointed.push(name);
  }

  await document.save();
  return { from, to, repointed };
}

export async function targetRename(
  from: string | undefined,
  to: string | undefined,
  flags: RenameFlags,
): Promise<void> {
  if (!from || !to) {
    throw new ConfigError('Usage: lanes link workspace rename <old-name> <new-name>');
  }

  const renamed = await renameTarget(from, to);

  await emit(flags.json, renamed, () => {
    print(ok(`${renamed.from} is now ${style.bold(renamed.to)}`));
    if (renamed.repointed.length > 0) {
      print(style.dim(`         repointed: ${renamed.repointed.join(', ')}`));
    }
    // The whole point of the rename is the flag somebody types every day.
    print(style.dim(`         pass --workspace ${renamed.to} from now on`));
  });
}
