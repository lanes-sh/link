import type { DeployStep, ProvisionInput } from '../driver.ts';
import { bucketSteps } from './bucket.ts';
import { requireProject } from './gcloud.ts';
import type { PolicyReader } from './iam.ts';
import { projectReadRemoval, secretGrantSteps } from './secrets.ts';

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

    // Through the shared builder rather than the three pieces, so a deploy and
    // a `connect` cannot drift — and so the policy read that decides what to
    // skip happens in one place. See `secretGrantSteps`.
    steps.push(...(await secretGrantSteps({ project, serviceAccount, readable, rotatable }, policy)));
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
        policy,
      })),
    );
  }

  return steps;
}
