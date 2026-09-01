import { ConfigError, DATA_DIR, isRemoteWorkspace, layout } from '#profile';
import { createFileSecretStore } from '#secrets';

/**
 * The credential half of the contract-3 migration.
 *
 * Split from `contract3-data.ts` when that file outgrew the budget, on the seam
 * the migration already had: objects move, credentials merge, and the two obey
 * different rules. A moved object has one home and the move is reversible by
 * moving it back. A merged credential has to survive two profiles claiming one
 * ref, and the wrong resolution points a live connection at somebody else's
 * account — so nothing here picks between two values, ever.
 *
 * The whole file is ordered around one promise: every refusal happens before
 * the first write.
 */

/**
 * What this migration needs to know about one profile's credentials.
 *
 * Assembled by `contract3.ts` from the hoist, because the two facts below are
 * decisions that file already made and this one must not make differently.
 */
export interface CredentialPlan {
  readonly profile: string;
  /** Every connection-derived credential ref, and where it is going. */
  readonly renames: ReadonlyMap<string, RefTarget>;
  /** This profile's endpoint token ref, which is deliberately not migrated. */
  readonly tokenRef: string;
}

/** What the merged credential store will hold, and what was left out of it. */
export interface CredentialMerge {
  /** Refs the merged store will hold, sorted. */
  readonly refs: readonly string[];
  /** Endpoint token refs left behind rather than merged, sorted. */
  readonly tokens: readonly string[];
}

/** Where a credential ref is going, and which connection it belongs to after. */
export interface RefTarget {
  readonly to: string;
  /** The settled `provider.id` this ref's connection became. */
  readonly connection: string;
}

/**
 * The credential ref of every connection the hoist touched, renamed or not.
 *
 * `credentialRefForConnection` derives `${app ?? provider}/${connectionId}` for
 * every auth kind that has a per-connection credential, and `hoistConnections`
 * renames the connection with `{ ...connection, id }` — which leaves the derived
 * ref pointing at the old id. So a profile whose `github.main` became
 * `github.main_2` still claimed `github/main`, and two profiles claiming one ref
 * with two different tokens is what aborted the migration.
 *
 * **Unrenamed connections are in here too**, which is not redundancy: the
 * `connection` half is what tells `readMerged` that two refs landing on one
 * target belong to the same connection and are therefore a merge rather than a
 * clash. Without it a single profile declaring `gmail.main` and `gmail.archive`
 * for one mailbox — legal under contract 2, and the reason tokens are
 * per-connection at all, since the scopes differ — was hoisted into one row and
 * then refused with "Two profiles hold different values", naming one profile
 * twice and prescribing a rename that cannot help.
 *
 * Only the `<provider>/<id>` spelling is derived here. A provider declaring
 * `auth.app` stores under `<app>/<id>` and a row carrying an explicit
 * `credential_ref` stores wherever it says — neither is reconstructable without
 * the manifest, which this migration does not load. Those refs are carried
 * across untouched, and a genuine clash between two of them is refused by name.
 */
export function connectionRefs(mapping: ReadonlyMap<string, string>): Map<string, RefTarget> {
  const refs = new Map<string, RefTarget>();

  for (const [from, to] of mapping) {
    const before = from.indexOf('.');
    const after = to.indexOf('.');
    if (before < 0 || after < 0) continue;
    refs.set(`${from.slice(0, before)}/${from.slice(before + 1)}`, {
      to: `${to.slice(0, after)}/${to.slice(after + 1)}`,
      connection: to,
    });
  }

  return refs;
}

/**
 * Every credential the merged store will hold, addressed as contract 3 will
 * address it.
 *
 * One walk, shared by the preview and the apply, because the two disagreeing is
 * the defect this replaces: `planCredentials` collected the union of ref *names*
 * and never compared values, so a clash it could not see aborted
 * `mergeCredentials` — at which point `rewriteRegistry` and `writeConnections`
 * had already run, and the workspace was half-migrated behind a message saying
 * nothing had been written.
 *
 * Read-only. Everything that can refuse, refuses here.
 *
 * **A workspace in a bucket has nothing to merge, and this says so rather than
 * finding out.** `workspacePath` refuses a filesystem adapter against a remote
 * root, so the only credential store such a workspace can declare is
 * `gcp-secret-manager` — whose refs were never scoped by profile, and are
 * therefore already what contract 3 wants. Without the guard the path below is
 * built by string interpolation into `gs://bucket/data/<profile>/credentials.enc`
 * and handed to `Bun.file`, where the failure is swallowed by the `catch` and
 * reads exactly like a workspace with no credentials in it.
 */
async function readMerged(
  root: string,
  plans: readonly CredentialPlan[],
): Promise<{ merged: Map<string, string>; tokens: Set<string> }> {
  const merged = new Map<string, string>();
  const held = new Map<string, { profile: string; connection?: string }>();
  // One entry per endpoint-token ref, holding what each profile had under it.
  // Decided after the walk, because whether it can be carried across depends on
  // whether the profiles agree — which is not known until they have all been read.
  const endpoint = new Map<string, Map<string, string>>();
  const tokens = new Set<string>();

  if (isRemoteWorkspace(root)) return { merged, tokens };

  for (const plan of plans) {
    const store = createFileSecretStore({
      path: `${root}/${DATA_DIR}/${plan.profile}/credentials.enc`,
    });

    let refs: string[];
    try {
      refs = await store.list();
    } catch {
      // A store that will not open is reported by `doctor`, not here. This runs
      // as a preview too, and must not fail on a workspace that is already
      // broken.
      continue;
    }

    for (const ref of refs) {
      // The endpoint's own bearer token, which every profile keeps under the
      // same ref because `authSchema` defaults `token_ref` to `profile/token`.
      // Under contract 2 that was unambiguous — one store per profile. Under
      // contract 3 there is one store, so three profiles' tokens are three
      // values for one key, and there is no merge that means anything.
      //
      // Left behind rather than picked between. It is minted locally rather
      // than granted by anybody, `ensureProfileToken` writes a fresh one the
      // first time a command asks, and the old stores are not deleted — so the
      // cost is re-registering a client, and no account has to be authorised
      // again.
      let value: string | null;
      try {
        value = await store.get(ref);
      } catch {
        continue;
      }
      if (value === null) continue;

      // The endpoint's own bearer token, held under one ref by every profile
      // because `authSchema` defaults `token_ref` to `profile/token`. Set aside
      // rather than merged here; see below.
      if (ref === plan.tokenRef) {
        const seen = endpoint.get(ref) ?? new Map<string, string>();
        seen.set(plan.profile, value);
        endpoint.set(ref, seen);
        continue;
      }

      const mapped = plan.renames.get(ref);
      const target = mapped?.to ?? ref;
      const first = merged.get(target);

      if (first !== undefined) {
        if (first === value) continue;

        // Two refs on one target whose connections are the same connection.
        // That is the hoist merging two rows for one account — legal under
        // contract 2, where `gmail.main` and `gmail.archive` could hold the
        // same mailbox at different scopes — and there is one connection now,
        // so one token. The first row is the one that survived the hoist, so
        // its credential is the one that belongs to it.
        const owner = held.get(target);
        if (mapped !== undefined && owner?.connection === mapped.connection) continue;

        throw new ConfigError(
          `Two credentials want to be at "${target}", and this migration cannot choose ` +
            `between them.\n` +
            `  ${owner?.profile ?? 'another profile'} and ${plan.profile} both hold one. Both ` +
            `are real credentials, and picking either would point a connection at the wrong ` +
            `account.\n` +
            `  Nothing has been written. Give one of them its own credential_ref before ` +
            `migrating.`,
        );
      }

      merged.set(target, value);
      held.set(target, {
        profile: plan.profile,
        ...(mapped === undefined ? {} : { connection: mapped.connection }),
      });
    }
  }

  // **A token is only left behind when the profiles disagree about it.**
  //
  // Under contract 2 each profile had its own store, so one ref meant one value
  // per profile and contract 3's single store cannot hold three of them. But a
  // workspace with one profile — or three that were registered from the same
  // token — has nothing to choose between, and dropping it there was gratuitous:
  // every client registered against that endpoint started getting 401s after a
  // routine `update`, for a conflict that did not exist.
  //
  // Where they do disagree it is still left behind rather than picked between.
  // It is minted locally rather than granted by anybody, `ensureProfileToken`
  // writes a fresh one the first time a command asks, and the old stores are not
  // deleted — so the cost is re-registering a client, and no account has to be
  // authorised again.
  for (const [ref, byProfile] of endpoint) {
    const values = new Set(byProfile.values());
    const agreed = values.size === 1 ? [...values][0] : undefined;

    if (agreed === undefined || merged.has(ref)) {
      tokens.add(ref);
      continue;
    }

    merged.set(ref, agreed);
    held.set(ref, { profile: [...byProfile.keys()].join(', ') });
  }

  return { merged, tokens };
}

/**
 * What the merge will do, computed before anything is written.
 *
 * The report an operator confirms is therefore the real one, and a refusal
 * leaves the workspace exactly as it was.
 */
export async function planCredentials(
  root: string,
  plans: readonly CredentialPlan[],
): Promise<CredentialMerge> {
  const { merged, tokens } = await readMerged(root, plans);
  return { refs: [...merged.keys()].sort(), tokens: [...tokens].sort() };
}

/**
 * Copy every profile's credentials into the workspace store.
 *
 * Written and read back before the old stores are touched, which is the whole
 * of the safety argument: a half-finished merge that has not deleted anything is
 * recoverable by running it again, and one that deleted first is not.
 *
 * The old stores are left in place regardless. They are a few kilobytes, they
 * are the only copy of anything if this went wrong, and `doctor` names them so
 * an operator can remove them once the endpoint has served a request.
 *
 * Skipped entirely for a workspace in a bucket, for the reason `readMerged`
 * gives: its credentials are in Secret Manager under refs that were never
 * per-profile, so there is no second store to fold in.
 */
export async function mergeCredentials(
  root: string,
  plans: readonly CredentialPlan[],
): Promise<void> {
  if (isRemoteWorkspace(root)) return;

  const { merged } = await readMerged(root, plans);
  const destination = createFileSecretStore({ path: `${root}/${layout.credentials()}` });

  for (const [ref, value] of merged) {
    const already = await destination.get(ref);
    if (already !== null) {
      // Already copied, by a run that did not get to the end. Anything else is
      // a store that disagrees with the profiles it was built from, which is
      // not something to overwrite silently.
      if (already === value) continue;
      throw new ConfigError(
        `${layout.credentials()} already holds a different value for "${ref}" than the profile ` +
          `stores do. Nothing has been deleted; resolve it and run this again.`,
      );
    }

    await destination.set(ref, value);
    if ((await destination.get(ref)) !== value) {
      throw new ConfigError(
        `The credential "${ref}" did not read back after being written to ` +
          `${layout.credentials()}. Nothing has been deleted; fix the store and run this again.`,
      );
    }
  }
}
