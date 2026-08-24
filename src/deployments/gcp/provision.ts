import { VAULT_DOCUMENT_REF } from '#secrets';
import type { DeployStep, ProvisionInput } from '../driver.ts';
import { encodeRef } from '../adapters/gcp-secret-manager.ts';
import { requireProject } from './gcloud.ts';

/**
 * The project-level things a Cloud Run deploy needs to already exist.
 *
 * These used to be a numbered list in `docs/detailed/deployment-cloudrun.md` that the
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

export function provisionSteps(input: ProvisionInput): Promise<DeployStep[]> {
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
    for (const ref of input.readable ?? []) {
      steps.push({
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
      });
    }
  }

  // What a revision rewrites in its own credential store, named one secret at a
  // time. Two kinds, and they arrive from different places:
  //
  //   - the vault document, because `vault.put` is a capability an agent may
  //     hold under policy (ADR-022);
  //   - each connection's OAuth token, because a refresh persists and serving a
  //     request is what triggers it (ADR-026).
  //
  // The second was missing, and the shape of the miss is worth keeping in mind:
  // nothing here was wrong, it was incomplete, and being incomplete looked
  // exactly like being finished. Reading mail 403'd an hour after every deploy.
  //
  // Two steps each, and the first is what keeps the second narrow: the secret is
  // created here so the revision only ever needs to *add a version*, never
  // `secrets.create`, which is a project-level permission that would let it mint
  // credential refs of its own. The binding is on the one secret, so it needs no
  // condition to be scoped — a resource-level grant already is.
  const writable = serviceAccount
    ? [
        ...(input.declared.vault?.adapter === 'secret'
          ? [input.declared.vault.ref ?? VAULT_DOCUMENT_REF]
          : []),
        ...(input.rotatable ?? []),
      ]
    : [];

  for (const ref of writable) {
    const id = encodeRef(ref);

    steps.push({
      title: `create the secret ${id}, so the revision never needs secrets.create`,
      argv: ['secrets', 'create', id, '--project', project, '--replication-policy', 'automatic'],
      tolerateFailure: true,
    });

    steps.push({
      title: `let the revision rewrite ${ref}, and nothing else in the store`,
      argv: [
        'secrets',
        'add-iam-policy-binding',
        id,
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
    });
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
    steps.push({
      title: `create the bucket gs://${bucket}`,
      argv: [
        'storage',
        'buckets',
        'create',
        `gs://${bucket}`,
        '--project',
        project,
        '--location',
        region,
        // Blobs here are read and written by one instance at a time and never
        // served publicly; uniform access removes per-object ACLs as a way to
        // get that wrong.
        '--uniform-bucket-level-access',
      ],
      tolerateFailure: true,
    });

    if (serviceAccount) {
      // Two conditioned bindings rather than one blanket objectAdmin, because
      // the bucket now holds the config as well as the data.
      //
      // ADR-007 says a deployed instance never mutates its own configuration.
      // That used to be enforced by the image being read-only, which stopped
      // being true when the workspace moved into the bucket (ADR-023). This is
      // where the guarantee went: the revision may write what it owns and may
      // only read what declares what it is.
      const objectsUnder = (path: string): string =>
        `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${path}")`;
      const objectIs = (path: string): string =>
        `resource.name == "projects/_/buckets/${bucket}/objects/${path}"`;

      // A provider manifest is configuration that happens to live inside the
      // profile's directory (ADR-030), so `data/` alone no longer separates
      // what the revision owns from what declares what it is. Anchored to the
      // profile segment rather than matched loosely: `contains("/providers.d/")`
      // would also catch a blob whose own key happened to spell it.
      const providerManifests =
        `resource.name.matches("^projects/_/buckets/${bucket}/objects/data/[^/]+/providers\\.d/")`;

      steps.push({
        title: 'let the revision write its own data, but not the manifests in it',
        argv: [
          'storage',
          'buckets',
          'add-iam-policy-binding',
          `gs://${bucket}`,
          '--member',
          `serviceAccount:${serviceAccount}`,
          // objectAdmin, not objectViewer: state, the log, attachments, memory
          // and skills are all written by the running endpoint.
          '--role',
          'roles/storage.objectAdmin',
          '--condition',
          `title=owns-its-data,expression=${objectsUnder('data/')} && !${providerManifests}`,
        ],
        tolerateFailure: true,
      });

      steps.push({
        title: 'let the revision read its config, and only read it',
        argv: [
          'storage',
          'buckets',
          'add-iam-policy-binding',
          `gs://${bucket}`,
          '--member',
          `serviceAccount:${serviceAccount}`,
          '--role',
          'roles/storage.objectViewer',
          // `expression=true` was here, which is every object in the bucket —
          // the step title and ADR-023 both claim a narrowing this did not do.
          // The config the revision reads is the workspace file, the profiles
          // beside it, and each profile's own manifests, so name exactly those.
          '--condition',
          `title=reads-its-config,expression=${objectsUnder('profiles/')} || ${objectIs('lanes-link.yaml')} || ${providerManifests}`,
        ],
        tolerateFailure: true,
      });
    }
  }

  return Promise.resolve(steps);
}
