import type { SecretRef } from '#secrets';
import type { DeployStep } from '../driver.ts';
import { encodeRef, retiresOldVersions } from '../adapters/gcp-secret-manager.ts';
import { holdsUnconditioned, type PolicyBinding, type PolicyReader } from './iam.ts';

/**
 * Secret Manager: the containers a deployment needs, and who may read and
 * rewrite each one.
 *
 * Split out of `provision.ts` for the reason `bucket.ts` was — it is a different
 * subject from "create the things this deploy needs", and it is reached from two
 * commands rather than one. `deploy` plans the whole config's refs; `connect`
 * plans the refs of the one connection it just wrote, through `secretGrantSteps`
 * below. A second spelling of a grant is not a wrong answer on screen, it is a
 * permission present on one path and missing on the other.
 *
 * Nothing here ever grants `secretmanager.secrets.create`. That half stays with
 * the operator, because it is project-level: an identity holding it could mint
 * credential references of its own, and that is the line — not writing.
 */

/**
 * Who the grant is for, and on what.
 *
 * A named type because these two functions are now called from two places that
 * must not disagree — see the note on `secretGrantSteps`.
 */
export interface SecretGrant {
  readonly project: string;
  readonly serviceAccount: string;
  readonly refs: readonly SecretRef[];
}

/**
 * Bring each secret into existence, so the bindings below have something to
 * attach to and the revision never needs `secrets.create` itself.
 *
 * That second half is the reason this is a step rather than left to whoever
 * writes the value: `secretmanager.secrets.create` is a project-level
 * permission, and a revision holding it could mint credential references of its
 * own. So the container is created here and the revision only ever adds a
 * version.
 *
 * The first half is why *read* grants need it too, which they did not have. A
 * binding cannot attach to a secret that does not exist — `gcloud` answers
 * `NOT_FOUND`, every step here tolerates failure, and the deploy carries on. On
 * a first deploy that is exactly what happened to the endpoint's own bearer
 * token: `prepareSecrets` mints it *after* provisioning, so the secret appeared
 * a step too late to be bound and the revision could not read the one value it
 * refuses to start without. A second deploy fixed it, which is why this survived
 * — the failure only ever showed up once per project.
 */
export function createSteps(input: {
  readonly project: string;
  readonly refs: readonly SecretRef[];
}): DeployStep[] {
  return input.refs.map((ref) => ({
    title: `create the secret ${encodeRef(ref)}, so the revision never needs secrets.create`,
    argv: [
      'secrets',
      'create',
      encodeRef(ref),
      '--project',
      input.project,
      '--replication-policy',
      'automatic',
    ],
    tolerateFailure: true,
  }));
}

/** Read, named one secret at a time, so the grant needs no condition to be scoped. */
export function readSteps({ project, serviceAccount, refs }: SecretGrant): DeployStep[] {
  return refs.map((ref) => ({
    title: `let the revision read ${ref}`,
    argv: [
      'secrets',
      'add-iam-policy-binding',
      encodeRef(ref),
      '--project',
      project,
      '--member',
      `serviceAccount:${serviceAccount}`,
      '--role',
      'roles/secretmanager.secretAccessor',
      // Bindings are printed as the whole policy otherwise, which is pages
      // of YAML per deploy and buries everything after it.
      '--condition',
      'None',
    ],
    tolerateFailure: true,
  }));
}

/**
 * Write, named one secret at a time, and never `secrets.create` — the container
 * is made by `createSteps` so this grant stays inside one secret.
 *
 * **`secretVersionManager` where a write retires its predecessor, adder where
 * it does not.** Adder can write a version and not retire the one it replaced,
 * and Secret Manager bills for every active version — so a revision holding
 * only adder has no way to stop paying for tokens it has already superseded,
 * and an often-read mailbox accumulates one per refresh without limit. Manager
 * adds destroy, disable, enable, get and list on top of add.
 *
 * The split is `retiresOldVersions`, which is the same predicate `#retire`
 * branches on, so the grant cannot outgrow the behaviour. The vault is
 * read-modify-write and is deliberately never retired, so granting it manager
 * would be a permission held for a call that is never made.
 *
 * `secrets/vault.ts` says `versions.destroy` is "deliberately not granted to
 * the identity a deployment runs as", and the reasoning behind that sentence
 * still holds in the form it was made: the fear is a revision that can reach
 * the *store*. This binding cannot. It is `add-iam-policy-binding` on one
 * named secret, so what the revision gains is the ability to retire old copies
 * of a credential it already writes and already reads. The thing actually
 * withheld — `secretmanager.secrets.create`, which is project-level and would
 * let a revision mint references of its own — is in neither role and is still
 * only ever exercised by `createSteps`, from an operator's machine.
 */
export function rotateSteps({ project, serviceAccount, refs }: SecretGrant): DeployStep[] {
  return refs.map((ref) => ({
    title: `let the revision rewrite ${ref}, and nothing else in the store`,
    argv: [
      'secrets',
      'add-iam-policy-binding',
      encodeRef(ref),
      '--project',
      project,
      '--member',
      `serviceAccount:${serviceAccount}`,
      '--role',
      retiresOldVersions(ref)
        ? 'roles/secretmanager.secretVersionManager'
        : 'roles/secretmanager.secretVersionAdder',
      '--condition',
      'None',
    ],
    tolerateFailure: true,
  }));
}

/** The union of two ref lists, deduplicated and ordered, so nothing is created twice. */
function union(...lists: readonly (readonly SecretRef[])[]): SecretRef[] {
  return [...new Set(lists.flat())].sort();
}

/**
 * Both halves for one connection's credentials, for a caller that is not a deploy.
 *
 * **This exists because the grant was a deploy-time snapshot of a set that
 * changes between deploys.** `provisionSteps` walks the config's connections and
 * binds each secret it finds; `connect` then adds a connection, writes its
 * credential, and binds nothing. The revision can read the new secret — an older
 * deployment's project-wide `secretAccessor` covers it, and a current one does
 * not — but it cannot add a version, so the first OAuth refresh 403s. The
 * connection works for exactly as long as its initial access token lasts, which
 * is about an hour, and then stops for a reason nothing on the connection says.
 *
 * So the same steps are reachable from `connect`, over one connection's refs
 * rather than the whole config's. Deliberately the *same functions* rather than
 * a second implementation: `reconcile.ts` makes the same argument for planning
 * and applying, and it holds harder here, because a second spelling of a grant
 * is not a wrong answer on screen, it is a permission that is missing in one
 * path and present in the other.
 */
export async function secretGrantSteps(
  grant: Omit<SecretGrant, 'refs'> & {
    readonly readable: readonly SecretRef[];
    readonly rotatable: readonly SecretRef[];
  },
  policy?: PolicyReader | undefined,
): Promise<DeployStep[]> {
  const { project, serviceAccount } = grant;
  const refs = union(grant.readable, grant.rotatable);
  const steps = [
    ...createSteps({ project, refs }),
    ...readSteps({ project, serviceAccount, refs: grant.readable }),
    ...rotateSteps({ project, serviceAccount, refs: grant.rotatable }),
  ];

  if (!policy) return steps;

  // **One read per secret, concurrently, to decide what not to write.** Each
  // `add-iam-policy-binding` is a read-modify-write of a whole policy and runs
  // in sequence; a `get-iam-policy` is a read and these run at once. Trading
  // every write for one read each is a saving even when nothing is skipped, and
  // when everything is already in place — the ordinary case, because every
  // deploy re-runs this — it is the difference between forty steps and none.
  //
  // Concurrently and before any of them run, because `runSteps` is sequential
  // and the answers must describe the policy as it was, not as an earlier step
  // in this same plan just left it.
  const current = new Map(
    await Promise.all(
      refs.map(async (ref) => [encodeRef(ref), await policy.secret(encodeRef(ref))] as const),
    ),
  );

  const member = `serviceAccount:${serviceAccount}`;
  return steps.filter((step) => !alreadyApplied(step, current, member));
}

/**
 * Whether this step would change nothing, judged against the policy as read.
 *
 * Reads the step's own argv rather than being told, so the three builders above
 * stay what they are — pure functions from refs to commands — and a fourth one
 * added later is covered without being taught about this.
 *
 * Both answers are conservative. A secret whose policy could not be read is
 * created and bound; a role not found on it is bound. Nothing here can decide a
 * grant is present on the strength of not having looked.
 */
function alreadyApplied(
  step: DeployStep,
  current: ReadonlyMap<string, readonly PolicyBinding[] | null>,
  member: string,
): boolean {
  const [noun, verb, id] = step.argv;
  if (noun !== 'secrets' || id === undefined) return false;

  // A policy came back, so the secret is there — see `PolicyReader.secret`.
  if (verb === 'create') return current.get(id) !== null && current.has(id);

  if (verb !== 'add-iam-policy-binding') return false;
  const role = step.argv[step.argv.indexOf('--role') + 1];
  return role !== undefined && holdsUnconditioned(current.get(id) ?? null, member, role);
}

/**
 * The project-wide secret read that per-secret bindings replaced.
 *
 * `roles/secretmanager.secretAccessor` on the whole project is what this deploy
 * used to grant, and removing it from the code did not remove it from anybody's
 * project: `add-iam-policy-binding` never took it away, and IAM unions what is
 * there. It kept working, which is the problem — a connection made after a
 * deploy could still be *read* by the revision through this binding while its
 * per-secret grant was missing, so the connection authorised, answered, and
 * reported `active` until the first token refresh needed a write. An hour of
 * looking healthy, and then a 403 nowhere near its cause.
 *
 * Only ever removed when this run granted read per secret. With no `readable`
 * set there is nothing to fall back to, and taking away the only grant the
 * revision has would be an outage caused by tidying.
 */
export async function projectReadRemoval(input: {
  readonly project: string;
  readonly member: string;
  readonly readable: readonly SecretRef[];
  readonly policy: PolicyReader | undefined;
}): Promise<DeployStep[]> {
  if (input.readable.length === 0 || !input.policy) return [];

  const current = await input.policy.project(input.project);
  const present = (current ?? []).some(
    (binding) =>
      binding.role === 'roles/secretmanager.secretAccessor' &&
      (binding.members ?? []).includes(input.member),
  );
  if (!present) return [];

  return [
    {
      title: 'drop the project-wide secret read the per-secret grants replaced',
      argv: [
        'projects',
        'remove-iam-policy-binding',
        input.project,
        '--member',
        input.member,
        '--role',
        'roles/secretmanager.secretAccessor',
        // Irrespective of any condition: every shape of this binding is one an
        // earlier version of this file wrote, and all of them are superseded.
        '--all',
      ],
      tolerateFailure: true,
      removes: true,
    },
  ];
}
