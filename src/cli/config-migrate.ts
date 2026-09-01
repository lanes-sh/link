import { ConfigError, renamedProviderFor, validateConfigShape, type Config } from '#profile';
import type { SecretStore } from '#secrets';
import { ConfigDocument } from './config-edit.ts';

/**
 * Applying a provider rename to a profile that still names the old id.
 *
 * Apart from `config-repair.ts` because the subject differs, not because either
 * file grew: that one gives a profile a surface it never had, reading a config
 * that loads. This one runs when the config does *not* load, which is the whole
 * difficulty. `renamedProviderFor` refuses a stale row at load (`#profile`), and
 * every command opens the config — so one row left saying `provider: tasks`
 * takes `status`, `start`, `plan` and `doctor` down together, for a state an
 * upgrade put the operator in without asking. The only way back was to
 * hand-edit YAML, which is not a thing a CLI should require to undo its own
 * release.
 *
 * So this reads raw YAML through `ConfigDocument` and edits it comment-first,
 * exactly as the other repairs do.
 *
 * **It never guesses.** A `tasks` row labelled anything but `Tasks` is either a
 * pre-rename Google Tasks connection or a hand-edited built-in one, and the
 * refusal names both because the two fixes are opposite. What decides here is
 * evidence rather than a heuristic: a stored credential at `tasks/<id>` can only
 * belong to the OAuth connection, because the built-in holds none and never
 * has. With no credential this reports both readings and changes nothing.
 */

/** One row that has to move. */
export interface PendingRename {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly id: string;
  readonly account: string;
  /** `provider.id`, as the rest of the CLI addresses a connection. */
  readonly key: string;
}

export interface RenameMigration {
  /** Every stale row found, whether or not it could be moved. */
  readonly rows: readonly PendingRename[];
  /** What was done, or would be — spelled for display. */
  readonly changes: readonly string[];
  /** What was left alone, each with why. */
  readonly blocked: readonly string[];
}

/**
 * The rows a document still spells the old way.
 *
 * Raw YAML, so nothing here has been through a schema — this runs on a file the
 * loader has already refused, and every field is whatever was typed. A row
 * missing `provider` or `account` is not a rename, it is a shape error, and
 * reporting that is `validateConfig`'s job rather than this one's.
 */
export function pendingRenames(document: ConfigDocument): PendingRename[] {
  const pending: PendingRename[] = [];

  connectionsOf(document).forEach((row, index) => {
    const { provider, id, account } = (row ?? {}) as {
      provider?: unknown;
      id?: unknown;
      account?: unknown;
    };
    if (typeof provider !== 'string' || typeof id !== 'string' || typeof account !== 'string') {
      return;
    }

    const moved = renamedProviderFor({ provider, account });
    if (moved) {
      pending.push({ index, from: provider, to: moved.to, id, account, key: `${provider}.${id}` });
    }
  });

  return pending;
}

/**
 * Report what a profile is owed, and optionally apply it.
 *
 * Takes the credential store rather than opening one, so the caller decides
 * whether the target is reachable and a test needs no adapter. `apply: false` is
 * what `doctor` prints without `--fix`: the same reading against the same
 * evidence, with nothing written.
 *
 * The credential is copied *before* the config is saved, and the old reference
 * deleted only after. A crash between the two leaves a second copy of a secret
 * the operator already holds — recoverable, and invisible. The other order
 * leaves a config naming a credential that is gone, which presents as a
 * connection that lost its authorisation for no reason anyone can see.
 */
export async function migrateRenamedProviders(
  connections: ConfigDocument,
  profiles: readonly ConfigDocument[],
  credentials: SecretStore,
  options: { apply: boolean },
): Promise<RenameMigration> {
  const document = connections;
  const rows = pendingRenames(document);
  if (rows.length === 0) return { rows, changes: [], blocked: [] };

  const changes: string[] = [];
  const blocked: string[] = [];
  const accepted: PendingRename[] = [];

  for (const row of rows) {
    if (await credentials.has(`${row.from}/${row.id}`)) {
      accepted.push(row);
      changes.push(`connections[${row.index}]: ${row.from} → ${row.to} (${row.key})`);
      changes.push(`credential: ${row.from}/${row.id} → ${row.to}/${row.id}`);
    } else {
      blocked.push(
        `${row.key} has no stored credential, so nothing proves it was ${row.to} rather than a ` +
          `built-in row labelled "${row.account}" by hand — set its provider or its account in ` +
          `the file itself`,
      );
    }
  }

  // The grant rules second, because whether one can move depends on what is
  // left declaring the old id once the rows above have — and because they live
  // in the profiles now rather than beside the connection (ADR-057), so this is
  // one pass per profile over a rename computed once.
  for (const row of accepted) {
    for (const profile of profiles) {
      changes.push(...renameGrantRules(profile, row, { apply: options.apply }).changes);
    }
  }

  if (!options.apply || accepted.length === 0) return { rows, changes, blocked };

  for (const row of accepted) {
    document.setIn(['connections', row.index, 'provider'], row.to);

    const value = await credentials.get(`${row.from}/${row.id}`);
    if (value !== null) await credentials.set(`${row.to}/${row.id}`, value);
  }

  // Throws unless the result is a config that loads, which is the assertion
  // worth having here — the whole premise was that it did not. Both files, in
  // the order that survives a crash between them: a grant naming a connection
  // that has not been renamed yet is refused at load, so the profiles go last.
  await document.save();
  if (options.apply) for (const profile of profiles) await profile.save();

  for (const row of accepted) await credentials.delete(`${row.from}/${row.id}`);

  return { rows, changes, blocked };
}

/**
 * Rewrite the grant rules that named the old id, where that is unambiguous.
 *
 * A rule names a provider and never an account, so `tasks.*` written for Google
 * Tasks has to follow the rename or the migrated connection is granted nothing
 * — `allowedConnections` drops a provider no rule covers before policy is even
 * consulted, so the repair would land a row that serves exactly as little as
 * the broken one did.
 *
 * The ambiguity this used to guard against is gone, and it is worth saying why.
 * A rule lived in one flat block and named a provider, so a profile holding a
 * Google Tasks row *and* the built-in had one `tasks.*` serving both — moving it
 * would silently revoke whichever kept its name, so the migration reported
 * rather than guessed. A rule lives inside the row that names one connection
 * now (ADR-058), so `tasks.*` on a `google_tasks` row is not ambiguous: it is
 * invalid, and `assertReferentialIntegrity` refuses it. There is nothing left to
 * decide.
 *
 * Both lists, on every row. A `deny` written to switch Google Tasks off means it
 * as firmly as an allow means it on, and leaving it behind would re-enable
 * something the operator turned off.
 *
 * The row's `connection` moves too, and that is new: a grant names the account
 * rather than the provider now (ADR-058), so `tasks.main` becomes
 * `google_tasks.main` or the grant resolves to nothing.
 */
function renameGrantRules(
  document: ConfigDocument,
  moved: { from: string; to: string; id: string; key: string },
  options: { apply: boolean },
): { changes: string[] } {
  const changes: string[] = [];

  const provider = { from: moved.from, to: moved.to };
  const grants = document.getIn(['grants']) as { items?: unknown[] } | null;

  (grants?.items ?? []).forEach((_row, at) => {
    const connection = document.getIn(['grants', at, 'connection']);
    if (typeof connection !== 'string') return;

    // The *exact* connection that moved, not every grant naming the old
    // provider. A workspace holding a Google Tasks row beside the built-in has
    // two `tasks.` grants and only one of them is being renamed — moving both
    // would point the built-in's grant at a connection that does not exist.
    if (connection !== moved.key) return;

    // The `connection` field always follows, and this is the one place the
    // ambiguity does not reach. It names the exact row being renamed, so there
    // is nothing to guess — and leaving it behind would point the grant at a
    // connection that no longer exists, which `assertGrantsResolve` refuses at
    // load. The rename would have made the workspace unopenable.
    const renamedConnection = `${provider.to}.${moved.id}`;
    if (options.apply) document.setIn(['grants', at, 'connection'], renamedConnection);
    changes.push(`grants[${at}].connection: ${connection} → ${renamedConnection}`);

    for (const field of ['allow', 'deny'] as const) {
      const rules = document.getIn(['grants', at, field]) as { items?: unknown[] } | null;

      (rules?.items ?? []).forEach((_item, index) => {
        // Either spelling: a bare pattern, or `{ capability, expires_at }`. The
        // path to it differs; the decision does not.
        const bare = document.getIn(['grants', at, field, index]);
        const path =
          typeof bare === 'string'
            ? (['grants', at, field, index] as const)
            : (['grants', at, field, index, 'capability'] as const);

        const capability = typeof bare === 'string' ? bare : document.getIn(path);
        if (typeof capability !== 'string') return;

        const [head, ...rest] = capability.split('.');
        if (head !== provider.from) return;

        const renamed = [provider.to, ...rest].join('.');
        if (options.apply) document.setIn(path, renamed);
        changes.push(`grants[${at}].${field}: ${capability} → ${renamed}`);
      });
    }
  });

  return { changes };
}

function keepsDeclaring(
  document: ConfigDocument,
  provider: string,
  accepted: readonly PendingRename[],
): boolean {
  return connectionsOf(document).some(
    (row, index) =>
      (row as { provider?: unknown } | null)?.provider === provider &&
      !accepted.some((moved) => moved.index === index),
  );
}

function connectionsOf(document: ConfigDocument): unknown[] {
  const config = document.toJSON() as { connections?: unknown } | null;
  return Array.isArray(config?.connections) ? config.connections : [];
}

/**
 * The config of a document the loader has refused, shape-checked only.
 *
 * `openSecretStoreFor` needs a `Config` to name the target's adapter, and the
 * document in hand fails the check that runs *after* the schema — so this is
 * that parse without it. A document failing the schema itself is beyond this
 * repair, and says so rather than reporting a rename it cannot see.
 */
export function shapeOf(document: ConfigDocument): Config {
  try {
    return validateConfigShape(document.toJSON(), document.path);
  } catch (error) {
    throw new ConfigError(
      `${document.path} is malformed beyond a provider rename, so there is nothing to migrate.\n` +
        `  ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
