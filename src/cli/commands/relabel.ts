import { CONNECTIONS_FILE, readConnections, type Resolution } from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, ok, print, style } from '../output.ts';
import { openRuntime, type GlobalFlags } from '../runtime.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { locate } from './connection.ts';

/**
 * `lanes link relabel` — the operator's own word for an account.
 *
 * Split from `disconnect` so `connection.ts` stays inside the size budget, and
 * on a real seam rather than a line count: `disconnect` reaches two files, every
 * profile that granted the row, and the credential store, while this writes one
 * field in one document.
 *
 * The label is a separate field from `account` for the reason the bug below
 * gives, and the two must not be merged back.
 */

export interface Relabelled {
  readonly profile: string;
  readonly target: string;
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly published: string;
}

export interface RelabelFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
}

/**
 * Rename a connection, writing `label` and never `account`.
 *
 * It wrote `account` until it was noticed that `account` is not a display name:
 * `settleIdentity` matches on it to tell a repair from a new account,
 * `idFromAccount` derives the id from it, and `gmail.send_message` writes it
 * into a `From` header. Renaming through it therefore un-recognised the account
 * it renamed — the next `connect` added a second row beside it.
 */
export async function renameConnection(
  key: string,
  label: string,
  flags: RelabelFlags,
): Promise<{ resolution: Resolution; relabelled: Relabelled }> {
  const runtime = await openRuntime(flags);

  try {
    const { resolution, config, target } = runtime;
    const root = resolution.workspaceRoot;

    // The workspace's file, not the profile's. A label is the operator's own
    // word for an account (ADR-057 moved the row that carries it), so renaming
    // it once renames it everywhere — which is what someone renaming "the work
    // mailbox" means, and what two copies could never keep true.
    const connectionsFile = await readConnections(root);
    const located = locate(connectionsFile.connections, key, target);

    const document = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
    document.setIn(['connections', located.index, 'label'], label);
    await document.save();

    return {
      resolution,
      relabelled: {
        profile: resolution.profile,
        target,
        key,
        // What it was called a moment ago, which is the account only until the
        // first rename.
        from: located.connection.label ?? located.connection.account,
        to: label,
        published: nextAfterEdit(await publishProfileEdit({ resolution, config, target })),
      },
    };
  } finally {
    await runtime.close();
  }
}

export async function relabel(
  key: string | undefined,
  label: string | undefined,
  flags: RelabelFlags,
): Promise<void> {
  if (!key) throw new Error('Which connection? Run: lanes link status');
  if (!label) throw new Error(`What should ${key} be called? Run: lanes link relabel ${key} "New name"`);

  const { resolution, relabelled: result } = await renameConnection(key, label, flags);

  return emit(flags.json, result, () => {
    announce(resolution);
    print(ok(`${style.bold(result.key)} is now ${style.bold(result.to)}`));
    if (result.from) print(`      was     ${style.dim(result.from)}`);
    // The label is a display name in two places, and only one of them changed.
    print(
      style.dim(
        '      The state store keeps the old name until the next reconcile, which updates it.',
      ),
    );
    if (result.published) print(style.dim(`      ${result.published}`));
  })
}
