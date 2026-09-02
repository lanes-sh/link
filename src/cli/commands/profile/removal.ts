import {
  layout,
  PROFILE_FILE,
  profilePath,
  vaultRef,
  workspacePath,
  type Config,
  type TargetConfig,
} from '#profile';
import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { credentialRefFor, ownClientRefsFor, type ProviderRegistry } from '#registry';
import { print, style, warn } from '../../output.ts';
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

/**
 * The credential references this profile declares, and only those.
 *
 * Locally the profile is the boundary: its credentials are a file inside its own
 * directory, and deleting the directory is the whole operation. In Secret
 * Manager they are flat names in one project, so two profiles deployed to the
 * same project share a namespace and `list()` hands back the other one's as
 * readily as its own. Deriving from what this profile declares is the only
 * answer that cannot delete something that was never ours, and a secret deleted
 * in the wrong project is not recoverable.
 *
 * The cost is that a genuinely orphaned ref — one whose connection was removed
 * from config long ago — is not derivable and so is not deleted. The caller
 * reports those rather than guessing, which is the honest position: a guess
 * here is indistinguishable from another profile's credential.
 */
export function declaredRefs(
  config: Config,
  declared: TargetConfig,
  /**
   * What the profiles that are staying declare.
   *
   * Nothing in here is deleted, however plainly the profile being removed also
   * declares it. The credential store is one file per *workspace* since
   * contract 3, and every profile takes the template default
   * `token_ref: profile/token` — so removing one profile deleted the endpoint
   * token the others are served by, and the deployed revision then refused every
   * request with "No profile token in this target's credential store". The vault
   * ref is read off the target and is identical for every profile there, which
   * made the sibling's sealed items unrecoverable in the same command.
   */
  survivors: readonly Config[] = [],
): string[] {
  const refs = new Set<string>([config.auth.token_ref]);

  // Read off the *target*, not the profile. `vaultTargetSchema` sits inside
  // `targetSchema`, so two targets may seal the same items in different places;
  // taking it from the profile would attach one target's vault to another
  // target's removal.
  //
  // **Through `vaultRef`, because the name carries the connection.** This said
  // `vault/document`, the contract-2 constant, while `openVault` seals under
  // `vault/<connection>` (ADR-059) — so removing a profile queued a ref nothing
  // had ever written and left the real document behind. Under-deletion rather
  // than over, since the survivor set was wrong the same way and they cancelled,
  // but what stayed behind is sealed credential material belonging to a profile
  // the operator asked to be gone. Per connection also makes the survivor check
  // mean something: two profiles granting different vaults no longer look like
  // one document to it.
  if (declared.vault?.adapter === 'secret') {
    refs.add(vaultRef(declared, config));
  }

  // **No connection credentials.** They belong to the workspace now (ADR-057),
  // and every one of them may be granted by a profile that is staying. Removing
  // a profile therefore removes no account and no credential — `lanes link
  // disconnect` is the command that does that, and it is the one that knows how
  // to check whether anybody else still needs the credential first.
  //
  // This is the sharpest edge in the whole decoupling, so `renderPlan` says it
  // out loud rather than leaving an operator to infer it from a short list:
  // "remove the work profile" used to mean "revoke what work could reach", and
  // it does not any more.
  if (config.auth.authorization?.mode === 'oidc') {
    refs.add(config.auth.authorization.client_id_ref);
  }

  // Shared with a profile that is staying, so not ours to delete. Computed the
  // same way for the survivors as for this one, because "what does a profile
  // declare" has to have one answer.
  const kept = new Set(
    survivors.flatMap((other) => [
      other.auth.token_ref,
      ...(declared.vault?.adapter === 'secret' ? [vaultRef(declared, other)] : []),
      ...(other.auth.authorization?.mode === 'oidc'
        ? [other.auth.authorization.client_id_ref]
        : []),
    ]),
  );

  return [...refs].filter((ref) => !kept.has(ref));
}

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
  readonly survivors?: readonly Config[] | undefined;
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
  config: Config,
  root: string,
  profile: string,
  registry: ProviderRegistry,
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
    if (config.knowledge) {
      warnings.push(
        `This profile keeps its memory and skills in ${config.knowledge.repo}. ` +
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
      const mine = new Set(declaredRefs(config, declared, options.survivors ?? []));

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

  return { profile, items, untouched, warnings };
}

const KIND_LABEL: Record<RemovalItem['kind'], string> = {
  secret: 'credential',
  blob: 'object',
  file: 'file',
  config: 'config',
  'workspace-key': 'workspace',
};

/**
 * The plan, as the thing an operator decides from.
 *
 * Rendered from the same value that is executed, so there is no second
 * description of the work to fall out of step with the first. It prints
 * references and keys and never a value — the plan holds no values to print.
 */
export function renderPlan(plan: RemovalPlan): void {
  print();
  print(`Removing profile ${style.bold(plan.profile)} would delete:`);
  print();

  if (plan.items.length === 0) {
    print(style.dim('  nothing — there is no trace of this profile left to remove.'));
  }

  const targets = [...new Set(plan.items.map((item) => item.target))];
  for (const target of targets) {
    const items = plan.items.filter((item) => item.target === target);
    print(`  ${style.bold(target ?? 'workspace')}`);
    for (const item of items) {
      const note = item.note ? style.dim(` — ${item.note}`) : '';
      const shown = item.area === undefined ? item.id : `${item.area}/${item.id}`;
      const into = item.movedTo ? style.dim(` → ${item.movedTo[0]}/${item.movedTo[1]}`) : '';
      print(`    ${KIND_LABEL[item.kind].padEnd(10)} ${shown}${into}${note}`);
    }
    print();
  }

  for (const { target, refs } of plan.untouched) {
    // Named rather than counted, because the operator is the only one who can
    // tell an orphan from another profile's live credential — and this command
    // deliberately will not guess.
    print(`  ${style.bold(target)}: present but not declared by this profile, so left alone`);
    for (const ref of refs) print(style.dim(`    ${ref}`));
    print();
  }

  for (const warning of plan.warnings) print(warn(warning));
  if (plan.warnings.length > 0) print();
}
