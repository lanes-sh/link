import type { SecretRef } from '#secrets';
import type { DeployStep, ProvisionInput } from '../driver.ts';
import { encodeRef } from '../adapters/gcp-secret-manager.ts';
import { bucketSteps } from './bucket.ts';
import { requireProject } from './gcloud.ts';
import type { PolicyReader } from './iam.ts';

/**
 * The project-level things a Cloud Run deploy needs to already exist.
 *
 * These used to be a numbered list in `https://lanes.sh/docs/link/deployment-cloudrun` that the
 * operator worked through by hand before their first deploy could get past its
 * first step. Everything here is derivable from what the target already
 * declares, so asking someone to transcribe it into a console was work with no
 * decision in it.
 *
 * Returned as steps rather than run, like the rollout itself, so `--dry-run`
 * shows the whole first-run sequence and so this is testable without a project.
 * Every one tolerates failure: the second deploy finds all of them present, and
 * `ALREADY_EXISTS` is the success case.
 */

/**
 * Enabled together, in one call.
 *
 * Cloud Build is not optional even though nothing here names it after the build
 * step: `gcloud builds submit` fails with a permission error rather than a
 * "not enabled" one, which reads as a broken account.
 *
 * The last two are for the steps *below this one*, and they were missing. Every
 * step here tolerates failure, so `iam.service-accounts create` and
 * `projects add-iam-policy-binding` against a project without them failed
 * silently — the deploy carried on, rolled a revision with no service account
 * and no binding, and the first symptom was the revision failing to read a
 * secret several minutes later. An API a later step needs belongs in the call
 * that enables APIs.
 */
const REQUIRED_SERVICES = [
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'storage.googleapis.com',
  'iam.googleapis.com',
  'cloudresourcemanager.googleapis.com',
];

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
 * is made by `createSteps` so this grant can stay at "add a version".
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
      'roles/secretmanager.secretVersionAdder',
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
export function secretGrantSteps(
  grant: Omit<SecretGrant, 'refs'> & {
    readonly readable: readonly SecretRef[];
    readonly rotatable: readonly SecretRef[];
  },
): DeployStep[] {
  const { project, serviceAccount } = grant;
  return [
    ...createSteps({ project, refs: union(grant.readable, grant.rotatable) }),
    ...readSteps({ project, serviceAccount, refs: grant.readable }),
    ...rotateSteps({ project, serviceAccount, refs: grant.rotatable }),
  ];
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
async function projectReadRemoval(input: {
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

export async function provisionSteps(
  input: ProvisionInput,
  /**
   * How to read the policies this deploy is about to change, so it can take away
   * what it supersedes as well as add what it means. Absent plans no removals —
   * see `PolicyReader`.
   */
  policy?: PolicyReader,
): Promise<DeployStep[]> {
  const cloudrun = requireProject(input.deploy, input.target);
  const { project, region, service_account: serviceAccount } = cloudrun;
  const steps: DeployStep[] = [];

  // Before everything, when the survey found no project by this name.
  //
  // `billing_account` is only written for a project that did not exist, so its
  // presence is the record of "this deploy owns creating it". Linking billing is
  // not optional and not deferrable: a project without it enables no API, and
  // every step below would fail describing the API rather than the billing.
  if (cloudrun.billing_account) {
    steps.push({
      title: `create the project ${project}`,
      argv: ['projects', 'create', project],
      tolerateFailure: true,
    });

    steps.push({
      title: `attach it to billing account ${cloudrun.billing_account}`,
      argv: [
        'billing',
        'projects',
        'link',
        project,
        '--billing-account',
        cloudrun.billing_account,
      ],
      tolerateFailure: true,
    });
  }

  steps.push({
    title: `enable the APIs this deploy uses (${REQUIRED_SERVICES.length})`,
    argv: ['services', 'enable', ...REQUIRED_SERVICES, '--project', project],
    tolerateFailure: true,
  });

  if (serviceAccount) {
    // The local part of the address is the account id gcloud wants; passing the
    // whole address creates `foo@bar.iam...@project.iam...`, which then fails
    // every binding below with a name that looks almost right.
    const accountId = serviceAccount.split('@')[0] || `${cloudrun.service}-run`;

    steps.push({
      title: `create the runtime service account ${accountId}`,
      argv: [
        'iam',
        'service-accounts',
        'create',
        accountId,
        '--project',
        project,
        '--display-name',
        `Lanes Link (${cloudrun.service})`,
      ],
      tolerateFailure: true,
    });

    // What a revision rewrites in its own credential store, named one secret at
    // a time. Two kinds, and they arrive from different places:
    //
    //   - the vault document, because `vault.put` is a capability an agent may
    //     hold under policy (ADR-022);
    //   - each connection's OAuth token, because a refresh persists and serving
    //     a request is what triggers it (ADR-026).
    //
    // The second was missing, and the shape of the miss is worth keeping in
    // mind: nothing here was wrong, it was incomplete, and being incomplete
    // looked exactly like being finished. Reading mail 403'd an hour after every
    // deploy.
    // Both kinds arrive already derived: the vault document is named per vault
    // connection (ADR-059) and only `prepare.ts` has the profile configs to work
    // it out. Naming `vault/document` here — the contract-2 constant — created
    // and granted one secret while `openVault` asked for another, and the
    // revision died on `PERMISSION_DENIED` before it could listen. See `vaultRef`.
    const rotatable = [...(input.rotatable ?? [])];

    // Read, named one secret at a time, for the same reason the write side is:
    // a resource-level grant needs no condition to be scoped.
    //
    // This was a project-wide `secretAccessor`. The adapter argued for it and
    // the argument was half right — the line worth defending really is
    // `secrets.create`, which stays with the operator — but project-wide read
    // is broader than a revision ever uses, and `askProject` is happy to point
    // a deploy at a project that already holds other things. An SSRF in the
    // endpoint should reach this profile's credentials, not everything sharing
    // a project with it.
    //
    // Affordable because the serving path reads by explicit ref: `list()` is a
    // CLI call, and `secretAccessor` never carried `secrets.list` anyway.
    // `readableRefs` derives the set from config and manifests at deploy time.
    const readable = input.readable ?? [];

    steps.push(...createSteps({ project, refs: union(readable, rotatable) }));
    steps.push(...readSteps({ project, serviceAccount, refs: readable }));
    steps.push(...rotateSteps({ project, serviceAccount, refs: rotatable }));
    steps.push(
      ...(await projectReadRemoval({
        project,
        member: `serviceAccount:${serviceAccount}`,
        readable,
        policy,
      })),
    );
  }

  // Any target that addresses a bucket, which deployed means all of them:
  // config, state, the log, memory, skills and attachments are all objects in
  // it, and it is the only stateful thing a deployment has besides Secret
  // Manager. A target on the filesystem adapter has no bucket, and creating
  // one it will never open would be a resource nobody asked for and nobody
  // deletes.
  const usesBucket =
    input.declared.storage.adapter === 'gcs' || input.declared.storage.adapter === 's3';
  const bucket = usesBucket ? input.declared.storage.bucket : undefined;
  if (bucket) {
    steps.push(
      ...(await bucketSteps({
        bucket,
        project,
        region,
        serviceAccount,
        profiles: input.profiles ?? [],
        policy,
      })),
    );
  }

  return steps;
}
