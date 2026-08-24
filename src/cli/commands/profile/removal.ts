import type { Config, TargetConfig } from '#profile';
import { credentialRefFor, ownClientRefsFor, type ProviderRegistry } from '#registry';

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
