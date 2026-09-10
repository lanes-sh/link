import {
  layout,
  PROFILE_FILE,
  profilePath,
  type TargetConfig,
} from '#profile';
import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { declaredRefs, unreachableRefs, type RemovalSubject } from './subject.ts';
import {
  migratesAcross,
  refuseSealedVault,
  resolveCollisions,
  type Disposition,
} from './disposition.ts';

/**
 * What a profile's removal is allowed to delete, worked out before any of it
 * happens.
 *
 * Everything here is a read. The plan is a value, and the preview an operator
 * confirms from is that value rendered — which is what stops what they were
 * shown and what runs from drifting apart. `../../../deployments/driver.ts`
 * gives the same reason for the same shape.
 */

export interface RemovalItem {
  /** `null` for a workspace-level item — the config file, the default-profile key. */
  readonly target: string | null;
  readonly kind: 'secret' | 'blob' | 'file' | 'config' | 'workspace-key';
  readonly id: string;
  readonly note?: string;
  /**
   * The area `id` is a key within, for a blob.
   *
   * Carried rather than derived: the two ends of a migration are two areas and
   * the executor opens both. Derived once, the plan prefixed the profile
   * directory onto `id` while the executor opened its default area — the copy
   * found nothing at the doubled path, wrote nothing, and the directory removal
   * took the bytes. A `--migrate-to` reported success and lost the data.
   */
  readonly area?: string;
  /** Where this object goes instead of being deleted, as `[area, key]`. */
  readonly movedTo?: readonly [string, string];
}


export interface RemovalPlan {
  readonly profile: string;
  readonly items: readonly RemovalItem[];
  /** Present in a target's store, not declared by this profile. Left alone. */
  readonly untouched: readonly { readonly target: string; readonly refs: readonly string[] }[];
  readonly warnings: readonly string[];
  /**
   * What a config that would not load stopped this from being able to name.
   *
   * **Not folded into `warnings`, deliberately.** A warning says "this survives
   * by design" — the repository, the deployed service, the accounts every
   * profile shares — and is true of a perfectly ordinary removal. One of these
   * says "this removal cannot see whether it survives", which is a different
   * sentence and the one that decides the exit code.
   */
  readonly unreachable: readonly string[];
  /** What could be read of the profile, for `--json` and for the preview. */
  readonly subject: SubjectReport;
}

/** The degraded read, in a shape fit to print and to serialise. */
export interface SubjectReport {
  readonly loaded: boolean;
  readonly name: string;
  readonly assumedName: boolean;
  readonly vaultConnection: string | null;
  /** A reference name, never a value — the plan prints refs everywhere else too. */
  readonly clientIdRef: string | null;
  readonly knowledgeRepo: string | null;
  readonly unread: readonly string[];
  readonly refusal: string | null;
}

export interface PlanOptions {
  /**
   * The target whose stores this plans against.
   *
   * Required now, and not a restriction: a profile lives in exactly one target
   * (ADR-052), so there is no "all of them" left for this to mean. It used to be
   * optional because a profile could declare several and removing it meant
   * emptying each.
   */
  readonly target: string;
  /** That target's adapter set, from the workspace declaring it (ADR-052). */
  readonly declared: TargetConfig;
  readonly openSecrets: (target: string) => Promise<SecretStore>;
  readonly openBlobs: (target: string, area?: string) => Promise<BlobStore>;
  readonly readDefaultProfile?: (() => Promise<string | undefined>) | undefined;
  /** What becomes of this profile's own bytes. */
  readonly disposition: Disposition;
  /**
   * The profiles that are staying.
   *
   * So a credential both this one and a survivor declares is left alone — see
   * `declaredRefs`. Defaulted to empty, which is the single-profile workspace
   * and the shape every existing caller had.
   */
  readonly survivors?: readonly RemovalSubject[] | undefined;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));


/**
 * Everything removing this profile would delete, before any of it is deleted.
 *
 * Read-only. A store that will not open becomes a warning rather than a throw,
 * because a target whose project is gone must not be able to strand a profile
 * on the machine forever — and the operator sees that warning in the preview,
 * before they confirm, rather than discovering it half way through.
 */
export async function removalPlan(
  subject: RemovalSubject,
  root: string,
  profile: string,
  options: PlanOptions,
): Promise<RemovalPlan> {
  const items: RemovalItem[] = [];
  const migrateInto =
    options.disposition.kind === 'migrate' ? options.disposition.into : undefined;
  const sealed: string[] = [];
  const untouched: { target: string; refs: string[] }[] = [];
  const warnings: string[] = [];

  // One target, always. A profile lived in as many as it declared and this
  // planned across all of them; it lives in exactly one now (ADR-052), and that
  // one is whichever workspace the caller resolved to reach this file.
  const names: string[] = [options.target];
  const declared = options.declared;

  for (const name of names) {

    // A repository this profile keeps memory and skills in is not this
    // command's to empty, and it is not reachable from here either: the routing
    // that points memory at a repository is applied by `openRuntime`, and this
    // plan is built on `openBlobStoreFor`, which opens the target's own declared
    // storage. That is the right answer — deleting a profile must not delete
    // somebody's repository — and it is a surprising one, because
    // `rm -r data/<profile>` used to be the whole of "what could this profile
    // reach". So it is said before the operator confirms rather than discovered
    // afterwards.
    if (subject.knowledgeRepo !== null) {
      warnings.push(
        `This profile keeps its memory and skills in ${subject.knowledgeRepo}. ` +
          'Nothing here touches a repository, so they survive this removal — delete them there ' +
          'if you want them gone.',
      );
    }

    // Secrets, and there is nothing left to order them against. This used to
    // run before a blob sweep because `layout.credentials(p)` was
    // `data/<p>/credentials.enc`, *inside* the blob root `data/<p>`, so
    // blobs-first deleted the store the secret deletions read through. Both the
    // sweep and the per-profile root are gone (ADR-057, ADR-059) — see the note
    // below — and the credential store is the workspace's now.
    try {
      const secrets = await options.openSecrets(name);
      const present = await secrets.list();
      const mine = new Set(declaredRefs(subject, declared, options.survivors ?? []));

      for (const ref of present) if (mine.has(ref)) items.push({ target: name, kind: 'secret', id: ref });

      const theirs = present.filter((ref) => !mine.has(ref));
      if (theirs.length > 0) untouched.push({ target: name, refs: theirs });
    } catch (cause) {
      warnings.push(
        `Target "${name}": its credential store could not be opened (${reason(cause)}), so nothing in it will be removed.`,
      );
    }

    // **The sweep is back, bounded by the profile's own directory.** It went
    // away under ADR-059, when a profile owned no bytes and the blob root was
    // the whole workspace — listing it then queued every byte in the workspace
    // for deletion because one profile was going. ADR-066 gives the directory
    // back, so it means what it used to: what this profile owns, and nothing an
    // account owns. `lanes link disconnect` is still the command for an
    // account, and nothing here touches one.
    try {
      const blobs = await options.openBlobs(name, layout.profileDir(profile));
      for (const blob of await blobs.list()) {
        // **Not the declaration.** It is config rather than data, deleted below
        // as its own item after everything it is the record of. Swept here it
        // would be counted twice, and on a `--migrate-to` copied into the
        // destination as a second `profile.yaml` — one profile's grants and
        // members landing inside another's directory.
        if (blob.key === PROFILE_FILE) continue;

        const migratable = migrateInto !== undefined && migratesAcross(blob.key);

        items.push({
          target: name,
          kind: 'blob',
          id: blob.key,
          area: layout.profileDir(profile),
          ...(migratable
            ? { movedTo: [layout.profileDir(migrateInto), blob.key] as const }
            : {}),
          ...(migrateInto !== undefined && !migratable
            ? { note: 'not migrated — deleted with the profile' }
            : {}),
        });

        if (migrateInto !== undefined && blob.key.startsWith('vault.d/')) sealed.push(blob.key);
      }
    } catch (cause) {
      warnings.push(
        `Target "${name}": its storage could not be opened (${reason(cause)}), so nothing in it will be removed.`,
      );
    }

    // The store's root is the profile's own directory, and an adapter must never
    // delete the root it was configured with — so emptying it leaves the
    // directory, and one left behind is silently reused by a later `profile add`
    // of the same name.
    if (declared.storage.adapter === 'filesystem') {
      items.push({
        target: name,
        kind: 'file',
        id: layout.profileDir(profile),
        note: 'the profile directory, once emptied',
      });
    }

    // A deployed revision reads its config from the bucket rather than the
    // image (ADR-023), so that copy is the profile too — and it is outside the
    // profile's blob tree, which is why it needs its own area.
    if (declared.storage.adapter === 'gcs' || declared.storage.adapter === 's3') {
      items.push({
        target: name,
        kind: 'config',
        id: layout.profileConfig(profile),
        note: 'the copy a deployed revision reads',
      });
    }

    // `deploy` only: the schema folds the deprecated `cloudrun` block into it,
    // so the resolved config has one answer rather than two that could differ.
    if (declared.deploy) {
      warnings.push(
        `Target "${name}" is deployed. The service will keep answering, and every call will fail, because what it served is gone. Tearing it down is not part of this.`,
      );
    }
  }

  // Always, now. `--target` used to mean "decommission this one target and leave
  // the profile behind", which was a coherent thing to want while a profile
  // could be declared against several. It lives in exactly one (ADR-052), and
  // the file itself is *in* that target's workspace — so emptying the target and
  // keeping the profile would leave a config nothing can open, in a workspace it
  // no longer belongs to.
  const defaultProfile = await options.readDefaultProfile?.();
  if (defaultProfile === profile) {
    items.push({
      target: null,
      kind: 'workspace-key',
      id: 'default_profile',
      note: 'cleared, not repointed at whatever remains',
    });
  }

  if (sealed.length > 0) refuseSealedVault(profile, migrateInto!);

  if (migrateInto !== undefined) {
    warnings.push(
      ...(await resolveCollisions(items, migrateInto, layout.profileDir(migrateInto), (area) =>
        options.openBlobs(options.target, area),
      )),
    );
  }

  // Last. It is the only record of where everything else lives, so a failure
  // before this point leaves data a later run can still find.
  items.push({ target: null, kind: 'config', id: profilePath(root, profile) });

  return {
    profile,
    items,
    untouched,
    warnings,
    unreachable: unreachableRefs(subject, declared, options.target),
    subject: {
      loaded: subject.config !== null,
      name: subject.name,
      assumedName: subject.assumedName,
      vaultConnection: subject.vaultConnection,
      clientIdRef: subject.clientIdRef,
      knowledgeRepo: subject.knowledgeRepo,
      unread: [...subject.unread],
      refusal: subject.refusal,
    },
  };
}
