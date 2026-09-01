import { grantedConnections } from '../../runtime.ts';
import { bindConnectionCredentials, type BindOutcome } from '#deployments/bind.ts';
import type { Runtime } from '../../runtime.ts';

/**
 * Step 7 of `connect`: bind the credential to the revision that will serve it.
 *
 * Split out for the reason every other step in this directory was — `index.ts`
 * holds the order, not the substance, and the file has a size budget
 * (`architecture.test.ts`) that exists to keep it that way.
 *
 * What it is for is in `deployments/bind.ts`. Two decisions belong here.
 *
 * **It is called ahead of `connect`'s early return, not after it.** Re-running
 * `connect` against an existing connection is what an operator does to repair
 * one, and that run reaches the end with no config changes to make. Binding
 * after the return would skip the repair path, leaving the command that looks
 * like the fix doing nothing about the actual fault.
 *
 * **A failure is a note, never a throw.** The credential is in the store and the
 * config is about to be saved by the time this runs, so failing the command
 * would report "connect failed" about a connect that happened — and connecting
 * an account against a deployed target from a machine that has never had
 * `gcloud` installed has to keep working.
 *
 * The third decision is which connection to bind. The declared row is
 * preferred over one assembled from the arguments, because an operator may have
 * written a `credential_ref` into the profile by hand and that field decides
 * where a `local` provider's credential lives — binding the derived ref instead
 * would grant a secret nobody writes and leave the written one unbound, which is
 * the failure `rotatableCredentialRefsFor` documents from the other direction.
 */
export function bindNewCredential(
  runtime: Runtime,
  providerId: string,
  connectionId: string,
  account: string,
): Promise<BindOutcome> {
  const declared = grantedConnections(runtime).find(
    (candidate) => candidate.provider === providerId && candidate.id === connectionId,
  );

  return bindConnectionCredentials({
    deploy: runtime.declared.deploy,
    target: runtime.target,
    connection: declared ?? { provider: providerId, id: connectionId, account },
    manifest: runtime.manifestFor(providerId),
  });
}
