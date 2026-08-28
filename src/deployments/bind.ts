import type { ConnectionConfig, DeployConfig } from '#profile';
import { credentialRefFor, rotatableCredentialRefsFor } from '#registry';
import type { SecretRef } from '#secrets';
import type { DeployDriver } from './driver.ts';
import { driverFor } from './drivers.ts';
import { secretGrantSteps } from './gcp/provision.ts';
import { requireProject } from './gcp/gcloud.ts';
import { encodeRef } from './adapters/gcp-secret-manager.ts';

/**
 * Binding one connection's credentials to the revision that will serve them.
 *
 * **The invariant this restores: a revision can rotate every credential it
 * serves.** `provisionSteps` establishes it over the connections the config held
 * *at deploy time*, one secret at a time, which is the right shape — a
 * resource-level grant needs no condition to be scoped. What nothing did was
 * keep it true afterwards. `connect` writes a credential into the same store and
 * binds nothing, so from the next connect until the next deploy the invariant is
 * false and no command says so.
 *
 * The failure it produces is the worst shape available. Read is unaffected, so
 * the connection authorises, answers, and reports `active`; only the *write* on
 * the far side of the first token refresh is denied, roughly an hour later, by
 * which time the connect that caused it is not the recent event. `status` and
 * `setup_overview` both keep saying "connected and reachable" throughout,
 * because both read the state store and the state store knows nothing about IAM.
 *
 * **Every path that writes a credential reaches this one.** `connect custom`
 * delegates to `runConnect` after writing its manifest, and `connectFamily`
 * calls `runConnect` per member, so binding at that one call site covers all
 * three. The reverse direction needs nothing: `disconnect` deletes the whole
 * secret rather than a version, and a secret's IAM policy goes with it, so there
 * is no orphaned binding to revoke.
 *
 * Same steps as the deploy, from the same functions, over one connection's refs.
 * Not a second implementation of the grant: `reconcile.ts` argues that a preview
 * computed differently from the mutation eventually becomes a lie, and the
 * argument is stronger here, because two spellings of a grant do not disagree on
 * screen — they disagree about which permission actually exists.
 */

export interface BindOutcome {
  /** Refs the revision can now read and rotate. Empty is a normal result. */
  readonly bound: readonly SecretRef[];
  /**
   * Why nothing was bound, when nothing was and that is fine: a local target, a
   * deployment with no runtime service account, or a provider holding no
   * credential at all.
   */
  readonly skipped?: string | undefined;
  /**
   * A binding that could not be applied, as a sentence for the operator.
   *
   * Carried rather than thrown, and that is deliberate. By the time this runs
   * the credential is already in the store and the config is already saved, so
   * failing the command would report "connect failed" about a connect that
   * happened. It also must not require `gcloud` to be installed: someone can
   * legitimately connect an account against a deployed target from a machine
   * that has never deployed one.
   */
  readonly failed?: string | undefined;
}

const NOTHING_TO_BIND = 'this provider stores no credential';

export async function bindConnectionCredentials(input: {
  readonly deploy: DeployConfig | undefined;
  readonly target: string;
  readonly connection: ConnectionConfig;
  /**
   * The provider's manifest, so an omitted `credential_ref` can be derived.
   *
   * Typed off `#registry`'s own signature rather than by importing
   * `ProviderManifest`: `#deployments` may not import `#connectivity`
   * (`architecture.test.ts`), which is the same rule that put `credentialRefFor`
   * in `#registry` in the first place. `prepare.ts` avoids it by never naming
   * the type; this one has to name it, so it derives it.
   */
  readonly manifest: Parameters<typeof rotatableCredentialRefsFor>[1];
  /** Injectable so a test asserts the argv without a cloud project near it. */
  readonly driver?: DeployDriver | undefined;
}): Promise<BindOutcome> {
  const { deploy, connection, manifest } = input;
  if (!deploy) return { bound: [], skipped: 'this target runs here, not on a platform' };

  const cloudrun = requireProject(deploy, input.target);
  const serviceAccount = cloudrun.service_account;
  if (!serviceAccount) {
    return { bound: [], skipped: 'this deployment declares no runtime service account' };
  }

  // Both halves, because a connection made since the last deploy has neither.
  // The read grant is the one an older deployment's project-wide
  // `secretAccessor` happens to cover, which is exactly what made this failure
  // partial and therefore slow to find; a deployment provisioned since that
  // changed has no read on it either.
  const readable = credentialRefFor(connection, manifest);
  const rotatable = rotatableCredentialRefsFor(connection, manifest);
  if (!readable && rotatable.length === 0) return { bound: [], skipped: NOTHING_TO_BIND };

  const steps = secretGrantSteps({
    project: cloudrun.project,
    serviceAccount,
    readable: readable ? [readable] : [],
    rotatable,
  });

  const driver = input.driver ?? (await driverFor(deploy.platform));

  for (const step of steps) {
    const result = await driver.run(step.argv, { quiet: true });
    // `tolerateFailure` on these means "the secret may already exist", which is
    // the create step's success case. A binding that genuinely could not be
    // applied is still worth saying out loud — quietly tolerating it here is how
    // the deploy path let this class of gap through in the first place.
    if (!result.ok && !step.argv.includes('add-iam-policy-binding')) continue;
    if (!result.ok) {
      return {
        bound: [],
        failed:
          `could not bind ${connection.provider}.${connection.id}'s credential to ` +
          `${serviceAccount}, so the deployed endpoint will be able to read it and not ` +
          'rotate it — which fails about an hour after the first use. ' +
          `Run \`lanes link deploy --target ${input.target}\` to bind it. ` +
          `(${driver.tool}: ${result.stderr.trim().split('\n').slice(-1)[0] ?? 'failed'})`,
      };
    }
  }

  return { bound: readable ? [readable, ...rotatable] : rotatable };
}

/**
 * The credentials a deployed revision serves but cannot rewrite.
 *
 * The detection half of the same invariant `bindConnectionCredentials` keeps.
 * Binding at connect time closes the gap going forward; this one answers for a
 * workspace that already has it, and for every way a binding can go missing that
 * no command is watching — a secret rebuilt by hand, a service account replaced,
 * a profile edited in an editor, a connection made by an older CLI.
 *
 * Asked of the platform rather than derived from a record this repository keeps,
 * because a record would only ever agree with itself. IAM is the thing that
 * actually decides, so IAM is what gets read.
 *
 * One call per ref, concurrently. `doctor` is the command where a few seconds
 * buys an answer nothing else on the machine can give — and the alternative,
 * finding out from a 403 an hour after a connect, is the failure this exists to
 * pre-empt.
 */
export async function unboundRotatableRefs(input: {
  readonly deploy: DeployConfig | undefined;
  readonly target: string;
  readonly connections: readonly ConnectionConfig[];
  readonly manifestFor: (providerId: string) => Parameters<typeof rotatableCredentialRefsFor>[1];
  readonly driver?: DeployDriver | undefined;
}): Promise<{ unbound: readonly SecretRef[]; unavailable?: string | undefined }> {
  const { deploy } = input;
  if (!deploy) return { unbound: [] };

  const cloudrun = requireProject(deploy, input.target);
  const serviceAccount = cloudrun.service_account;
  if (!serviceAccount) return { unbound: [] };

  const refs = new Set<SecretRef>();
  for (const connection of input.connections) {
    for (const ref of rotatableCredentialRefsFor(connection, input.manifestFor(connection.provider))) {
      refs.add(ref);
    }
  }
  if (refs.size === 0) return { unbound: [] };

  const driver = input.driver ?? (await driverFor(deploy.platform));
  const member = `serviceAccount:${serviceAccount}`;

  const verdicts = await Promise.all(
    [...refs].map(async (ref) => {
      const result = await driver.run(
        ['secrets', 'get-iam-policy', encodeRef(ref), '--project', cloudrun.project, '--format', 'json'],
        { quiet: true },
      );
      // A ref whose policy cannot be read is not reported as unbound: "could not
      // look" and "is not granted" send an operator to different places, and
      // this command exists to be trusted about the second one.
      if (!result.ok) return { ref, bound: true, unreadable: true };

      try {
        const policy = JSON.parse(result.stdout) as {
          bindings?: { role?: string; members?: string[] }[];
        };
        const bound = (policy.bindings ?? []).some(
          (binding) =>
            binding.role === 'roles/secretmanager.secretVersionAdder' &&
            (binding.members ?? []).includes(member),
        );
        return { ref, bound, unreadable: false };
      } catch {
        return { ref, bound: true, unreadable: true };
      }
    }),
  );

  const unreadable = verdicts.filter((verdict) => verdict.unreadable).length;
  return {
    unbound: verdicts.filter((verdict) => !verdict.bound).map((verdict) => verdict.ref),
    ...(unreadable > 0
      ? {
          unavailable:
            `${unreadable} of ${refs.size} credential policies could not be read, so this ` +
            `check covered the rest. ${driver.tool} has to be installed and authorised for it.`,
        }
      : {}),
  };
}
