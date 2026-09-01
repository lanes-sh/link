import { layout, profilePath, workspacePath, type Config, type TargetConfig } from '#profile';
import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { credentialRefFor, ownClientRefsFor, type ProviderRegistry } from '#registry';
import { print, style, warn } from '../../output.ts';

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
  if (declared.vault?.adapter === 'secret') {
    refs.add(declared.vault.ref ?? 'vault/document');
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
      ...(declared.vault?.adapter === 'secret' ? [declared.vault.ref ?? 'vault/document'] : []),
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

    // Secrets first, and this ordering is load-bearing rather than tidy:
    // `layout.credentials(p)` is `data/<p>/credentials.enc`, *inside* the blob
    // root `data/<p>`. For the file adapter the credential store is itself a
    // blob, so blobs-first would delete the store the secret deletions read
    // through and turn every one of them into a failure.
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

    // **No blob sweep, and no profile directory.** Both existed because a
    // profile owned `data/<profile>/`, and `rm -r` on it was exactly "what could
    // this profile reach". It owns nothing now (ADR-057, ADR-059): the blob root
    // is the workspace's, and the stores under it belong to connections other
    // profiles may grant. Listing it here would queue every byte in the
    // workspace for deletion because one profile is going.
    //
    // What replaces it is `lanes link disconnect`, which takes one connection,
    // its grants, and its credential — after checking whether anything else
    // still needs them. That check is the whole reason this cannot happen here.

    // A deployed revision reads its config from the bucket rather than the
    // image (ADR-023), so that copy is the profile too — and it is outside the
    // profile's blob tree, which is why it needs its own area.
    if (declared.storage.adapter === 'gcs' || declared.storage.adapter === 's3') {
      items.push({
        target: name,
        kind: 'config',
        id: `profiles/${profile}.yaml`,
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
      print(`    ${KIND_LABEL[item.kind].padEnd(10)} ${item.id}${note}`);
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
