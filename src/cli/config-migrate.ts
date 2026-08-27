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
  document: ConfigDocument,
  credentials: SecretStore,
  options: { apply: boolean },
): Promise<RenameMigration> {
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

  // The policy rules second, because whether one can move depends on what is
  // left declaring the old id once the rows above have.
  for (const [from, to] of new Map(accepted.map((row) => [row.from, row.to]))) {
    const policy = renamePolicyRules(document, { from, to }, {
      stillDeclared: keepsDeclaring(document, from, accepted),
      apply: options.apply,
    });
    changes.push(...policy.changes);
    blocked.push(...policy.blocked);
  }

  if (!options.apply || accepted.length === 0) return { rows, changes, blocked };

  for (const row of accepted) {
    document.setIn(['connections', row.index, 'provider'], row.to);

    const value = await credentials.get(`${row.from}/${row.id}`);
    if (value !== null) await credentials.set(`${row.to}/${row.id}`, value);
  }

  // Throws unless the result is a config that loads, which is the assertion
  // worth having here — the whole premise was that it did not.
  await document.save();

  for (const row of accepted) await credentials.delete(`${row.from}/${row.id}`);

  return { rows, changes, blocked };
}

/**
 * Rewrite the policy rules that named the old id, where that is unambiguous.
 *
 * A rule names a provider and never an account, so `tasks.*` written for Google
 * Tasks has to follow the rename or the migrated connection is granted nothing
 * — `allowedConnections` drops a provider no rule covers before policy is even
 * consulted, so the repair would land a row that serves exactly as little as
 * the broken one did.
 *
 * But a profile declaring *both* — a Google Tasks row and the built-in — has one
 * rule serving two providers, and moving it would silently revoke the one that
 * kept its name. That profile keeps its rule and is told to add the second,
 * which is a sentence rather than a guess at which was meant.
 *
 * Both lists. A `deny` written to switch Google Tasks off means it as firmly as
 * an allow means it on, and leaving it behind would re-enable something the
 * operator turned off.
 */
function renamePolicyRules(
  document: ConfigDocument,
  provider: { from: string; to: string },
  options: { stillDeclared: boolean; apply: boolean },
): { changes: string[]; blocked: string[] } {
  const changes: string[] = [];
  const blocked: string[] = [];

  for (const field of ['allow', 'deny'] as const) {
    const rules = document.getIn(['policy', field]) as { items?: unknown[] } | null;

    (rules?.items ?? []).forEach((_item, index) => {
      // Either spelling: a bare pattern, or `{ capability, expires_at }`. The
      // path to it differs; the decision does not.
      const bare = document.getIn(['policy', field, index]);
      const path =
        typeof bare === 'string'
          ? (['policy', field, index] as const)
          : (['policy', field, index, 'capability'] as const);

      const capability = typeof bare === 'string' ? bare : document.getIn(path);
      if (typeof capability !== 'string') return;

      const [named, ...rest] = capability.split('.');
      if (named !== provider.from) return;

      const moved = [provider.to, ...rest].join('.');

      if (options.stillDeclared) {
        blocked.push(
          `policy.${field} keeps "${capability}" — this profile still declares a ` +
            `"${provider.from}" connection, so add "${moved}" rather than moving it`,
        );
        return;
      }

      if (options.apply) document.setIn(path, moved);
      changes.push(`policy.${field}: ${capability} → ${moved}`);
    });
  }

  return { changes, blocked };
}

/**
 * Whether a row naming the old provider survives the migration.
 *
 * Computed against the accepted set rather than by re-reading the document,
 * because the same answer has to hold on a report-only run, where nothing has
 * been rewritten yet.
 */
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
