import { profilePath, type Config, type TargetConfig } from '#profile';
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
  registry: ProviderRegistry,
  declared: TargetConfig,
): string[] {
  const refs = new Set<string>([config.auth.token_ref]);

  // Read off the *target*, not the profile. `vaultTargetSchema` sits inside
  // `targetSchema`, so two targets may seal the same profile's items in
  // different places; taking it from the profile would attach one target's
  // vault to another target's removal.
  if (declared.vault?.adapter === 'secret') {
    refs.add(declared.vault.ref ?? 'vault/document');
  }

  for (const connection of config.connections) {
    const manifest = registry.manifest(connection.provider);

    // `credentialRefFor` rather than `credentialRefForConnection`: it is the
    // single authority on where a connection's credential lives, and it exists
    // because two callers once derived the answer differently and disagreed.
    // Asking the lower-level one here would open that gap again from a third
    // side — and it would miss a `local` provider, whose only ref is the one
    // the connection declares itself.
    const ref = credentialRefFor(connection, manifest);
    if (ref) refs.add(ref);

    if (manifest) {
      for (const own of ownClientRefsFor(manifest, config.oauth_apps)) refs.add(own);
    }
  }

  return [...refs];
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
  /** Restrict to one target. The profile itself then survives. */
  readonly target?: string | undefined;
  readonly openSecrets: (target: string) => Promise<SecretStore>;
  readonly openBlobs: (target: string, area?: string) => Promise<BlobStore>;
  readonly readDefaultProfile?: (() => Promise<string | undefined>) | undefined;
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

  const names = options.target ? [options.target] : Object.keys(config.targets);

  for (const name of names) {
    const declared = config.targets[name];
    if (!declared) {
      warnings.push(`Target "${name}" is not declared by this profile, so nothing was planned.`);
      continue;
    }

    // Secrets first, and this ordering is load-bearing rather than tidy:
    // `layout.credentials(p)` is `data/<p>/credentials.enc`, *inside* the blob
    // root `data/<p>`. For the file adapter the credential store is itself a
    // blob, so blobs-first would delete the store the secret deletions read
    // through and turn every one of them into a failure.
    try {
      const secrets = await options.openSecrets(name);
      const present = await secrets.list();
      const mine = new Set(declaredRefs(config, registry, declared));

      for (const ref of present) if (mine.has(ref)) items.push({ target: name, kind: 'secret', id: ref });

      const theirs = present.filter((ref) => !mine.has(ref));
      if (theirs.length > 0) untouched.push({ target: name, refs: theirs });
    } catch (cause) {
      warnings.push(
        `Target "${name}": its credential store could not be opened (${reason(cause)}), so nothing in it will be removed.`,
      );
    }

    try {
      const blobs = await options.openBlobs(name);
      for (const blob of await blobs.list()) items.push({ target: name, kind: 'blob', id: blob.key });
    } catch (cause) {
      warnings.push(
        `Target "${name}": its storage could not be opened (${reason(cause)}), so nothing in it will be removed.`,
      );
    }

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

  // Only when the whole profile is going. With `--target` it still exists.
  if (!options.target) {
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
  }

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
