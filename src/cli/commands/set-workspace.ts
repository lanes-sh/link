import {
  ConfigError,
  WORKSPACE_FILE,
  readRegistry,
  readWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { ok, print, style } from '../output.ts';

/**
 * `lanes set-workspace <name>` — which workspace a command means when it does
 * not say.
 *
 * ADR-037 deleted the command this replaces, and its reasoning is the thing to
 * read before changing anything here:
 *
 * > Persisted context state is the standard way operators run destructive
 * > commands against the wrong target, and the version of it that bites is the
 * > dotfile nothing prints.
 *
 * Both halves of that sentence are answered rather than argued with (ADR-061).
 * The default is **printed on every command that uses it**, so it is not the
 * dotfile nothing prints; and it is **refused by every command that publishes or
 * destroys**, so it is not what runs a destructive command against the wrong
 * thing. Take either half away and the objection stands again.
 *
 * Top level rather than under `lanes link`, because it selects the workspace
 * *the CLI* acts in and a second area added to `lanes` will want the same
 * answer.
 */

export interface SetWorkspaceResult {
  readonly workspace: string;
  readonly previous: string | null;
  readonly path: string;
}

export async function setWorkspace(
  name: string | undefined,
  options: { json?: boolean } = {},
): Promise<void> {
  const root = resolveWorkspaceRoot();

  if (name === undefined) {
    const current = (await readWorkspace(root))?.default_workspace;
    throw new ConfigError(
      `Usage: lanes set-workspace <name>\n` +
        (current ? `  The default is currently "${current}".\n` : '  No default is set.\n') +
        `  Run "lanes link workspace list" to see what there is.`,
    );
  }

  // Checked against the registry, not accepted on trust. A default naming a
  // workspace that does not exist would turn every later command's refusal into
  // one about the wrong thing — and the operator would have been told "ok" by
  // the command that caused it.
  const registry = await readRegistry(root);
  if (!(name in registry)) {
    const names = Object.keys(registry).sort();
    throw new ConfigError(
      `${root} declares no workspace "${name}".\n` +
        (names.length > 0
          ? `  It has: ${names.join(', ')}\n`
          : '  It has none yet. Create one with: lanes link profile add <name> --workspace local\n') +
        `  Run "lanes link workspace list" to see them.`,
    );
  }

  const document = await ConfigDocument.openKey(root, WORKSPACE_FILE);
  const previous = document.getIn(['default_workspace']);
  document.setIn(['default_workspace'], name);
  await document.save();

  const result: SetWorkspaceResult = {
    workspace: name,
    previous: typeof previous === 'string' ? previous : null,
    path: `${root}/${WORKSPACE_FILE}`,
  };

  if (options.json === true) {
    print(JSON.stringify(result, null, 2));
    return;
  }

  print(ok(`default workspace: ${style.bold(name)}`));
  print(style.dim(`      ${result.path}`));
  print('');
  print(
    style.dim(
      '      Every command that uses it prints it. Commands that publish or destroy —\n' +
        '      deploy, sync, secrets push, profile remove, disconnect, token rotate —\n' +
        '      still want --workspace typed out.',
    ),
  );
}
