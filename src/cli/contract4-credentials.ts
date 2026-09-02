import { ConfigError } from '#profile';
import type { SecretStore } from '#secrets';
import { credentialRefFor } from '#registry';
import type { ProviderRegistry } from '#registry';
import type { ConnectionConfig } from '#profile';
import { rotatableCredentialRefs } from '#connectivity';
import type { Renames } from './contract4-data.ts';

/**
 * Move each stored credential to the ref its renamed connection now derives.
 *
 * **The step without which the rename loses every account.** A `credential_ref`
 * is almost never written down: `credentialRefFor` derives it as
 * `<provider>/<connection>`, so renaming `gmail.main_2` to `gmail.con17`
 * silently repoints the lookup at a key nothing holds. Config, blobs and state
 * all move; the secret stays where it was, and the endpoint reports "no stored
 * credential" for an account that is still perfectly well authorised.
 *
 * Found by rehearsing the migration against a real workspace, where it turned
 * six live credentials into six re-authorisations. ADR-051 records why that is
 * not an acceptable release note.
 *
 * Refs come from the same authority the runtime resolves them with, rather than
 * from a pattern over the store's keys. A ref is not always
 * `<provider>/<id>` — an `oauth_apps` entry puts the app's name in front
 * instead — and matching on the last segment cannot tell `google/main` for a
 * renamed Gmail connection from `google/main` for a renamed Drive one.
 */
export interface CredentialMove {
  readonly from: string;
  readonly to: string;
}

export function planCredentialMoves(
  connections: readonly ConnectionConfig[],
  registry: ProviderRegistry,
  renames: Renames,
): CredentialMove[] {
  const moves: CredentialMove[] = [];
  const seen = new Set<string>();

  for (const connection of connections) {
    const to = renames.get(`${connection.provider}.${connection.id}`);
    if (to === undefined) continue;

    const id = to.slice(to.indexOf('.') + 1);
    if (id === connection.id) continue;

    const manifest = registry.manifest(connection.provider);
    const after = { ...connection, id };

    // A ref the row states outright does not move: it names a key the operator
    // chose, and the id it happens to contain is not this migration's to read.
    const refs: [string | undefined, string | undefined][] = [
      [credentialRefFor(connection, manifest), credentialRefFor(after, manifest)],
    ];

    // An OAuth connection also holds the token blob `saveTokens` rewrites, and
    // it is the one that matters — the hot path of an ordinary read.
    if (manifest) {
      const before = rotatableCredentialRefs(manifest, connection.id);
      const now = rotatableCredentialRefs(manifest, id);
      for (let index = 0; index < before.length; index += 1) {
        refs.push([before[index], now[index]]);
      }
    }

    for (const [from, into] of refs) {
      if (from === undefined || into === undefined || from === into) continue;

      // Keyed on the *pair*, not on the source. Several connections can derive
      // one ref — three iCloud surfaces authorised as one account share
      // `icloud/<id>` through `auth.app` — and giving distinct ids to each
      // turns one credential into three. Deduping on the source sent it to
      // whichever connection came first and orphaned the rest, which is what a
      // real workspace showed on the first rehearsal.
      const pair = `${from}\u0000${into}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      moves.push({ from, to: into });
    }
  }

  return moves;
}

/**
 * Apply them, reading each value back before the old key is removed.
 *
 * The same rule the blob mover follows: a credential that half moved and a
 * source already gone is the one state with nothing to retry from. A ref whose
 * destination is already occupied is left alone rather than overwritten —
 * that is a rerun finding its own work, and clobbering it would be the one
 * irreversible thing here.
 */
export async function applyCredentialMoves(
  store: SecretStore,
  moves: readonly CredentialMove[],
): Promise<string[]> {
  const applied: string[] = [];
  const skipped: string[] = [];

  // Grouped by source, because one credential may feed several destinations
  // and the source may only go once every one of them is written. Deleting
  // after the first would take it away from the connections still to come.
  const bySource = new Map<string, string[]>();
  for (const move of moves) {
    const into = bySource.get(move.from) ?? [];
    into.push(move.to);
    bySource.set(move.from, into);
  }

  for (const [from, destinations] of bySource) {
    const value = await store.get(from);
    if (value === null) continue;

    // **The source goes only once every destination holds this value.** The
    // delete used to sit outside this loop while the loop skipped an occupied
    // destination — so a ref already holding something (a stale credential a
    // `disconnect --keep-credential` left behind, or an unrelated account's)
    // meant nothing was written and the source was destroyed anyway, reported
    // as a successful move. `migrate-move.ts` guards the same hazard with
    // `sameBytes`, and this is that guard.
    let carried = true;

    for (const to of destinations) {
      const held = await store.get(to);

      if (held !== null) {
        // Our own earlier work, so this destination is done. Anything else is
        // somebody's credential and is not ours to overwrite or to delete the
        // source out from under.
        if (held !== value) {
          carried = false;
          skipped.push(
            `${from} → ${to}: ${to} already holds a different value, so nothing was moved or ` +
              'deleted. Remove or rename it and run this again.',
          );
        }
        continue;
      }

      await store.set(to, value);
      if ((await store.get(to)) === null) {
        throw new ConfigError(
          `${to} did not read back after being written. Nothing has been deleted; ` +
            'fix the credential store and run this again.',
        );
      }
    }

    if (!carried) continue;

    await store.delete(from);
    applied.push(`${from} → ${destinations.join(', ')}`);
  }

  return [...applied, ...skipped];
}

/**
 * The sealed vault document, which `credentialRefFor` cannot see.
 *
 * A vault connection's `auth.kind` is `none`, so `credentialRefForConnection`
 * returns `undefined` for it and the loop above skips it entirely — while
 * `vaultRef` names the document `vault/<profile>/<connection>` and a deployed
 * target seals it in Secret Manager. Contract 4 renames the connection and
 * gives the ref a profile, so without this the revision opens a name nothing
 * created: every vault item reads as absent, with no error, and the ciphertext
 * sits orphaned under the old ref.
 *
 * Invisible in a local rehearsal, because the `file` and `blob` adapters take
 * their path from `layout` and were already correct. `secret` is the adapter
 * every deployment uses.
 *
 * A `ref` the target states outright is left alone: it names a document the
 * operator chose, and a deployment already sealing under it has to keep
 * opening it.
 */
export function planVaultMoves(
  profiles: ReadonlyMap<string, { grants?: { connection?: unknown }[] }>,
  renames: Renames,
  declaredRef: string | undefined,
): CredentialMove[] {
  if (declaredRef !== undefined) return [];

  const moves: CredentialMove[] = [];

  for (const [profile, config] of profiles) {
    const granted = (config.grants ?? [])
      .map((grant) => grant.connection)
      .find((ref): ref is string => typeof ref === 'string' && ref.startsWith('vault.'));

    // `main` where the profile grants none, which is what `vaultRef` falls back
    // to — so a profile that denied the vault still finds its own document
    // rather than another profile's.
    const was = granted === undefined ? 'main' : granted.slice('vault.'.length);
    const to = granted === undefined ? undefined : renames.get(granted);
    const now = to === undefined ? was : to.slice(to.indexOf('.') + 1);

    const from = `vault/${was}`;
    const into = `vault/${profile}/${now}`;
    if (from !== into) moves.push({ from, to: into });
  }

  return moves;
}
