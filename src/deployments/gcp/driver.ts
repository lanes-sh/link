import type {
  CommandResult,
  DeployDriver,
  DeployStep,
  PlanInput,
  ProvisionInput,
  SurveyInput,
  SurveyResult,
} from '../driver.ts';
import { join } from 'node:path';
import { installRoot, type DeployConfig } from '#profile';
import { encodeRef } from '../adapters/gcp-secret-manager.ts';
import {
  captureGcloud,
  gcloudPath,
  gcloudPolicy,
  requireProject,
  runGcloud,
  serviceUrl,
  type CloudRunTarget,
} from './gcloud.ts';
import { provisionSteps } from './provision.ts';
import { surveyCloudRun } from './survey.ts';

/**
 * Cloud Run.
 *
 * Everything Google-specific about deploying lives behind this object: the argv
 * `gcloud` wants, the shape of an Artifact Registry reference, and the fact that
 * a Cloud Run URL has to be asked for rather than constructed. The generic
 * command in `../deploy.ts` knows none of it.
 *
 * Config travels one way — from the CLI into an image — and a deployed instance
 * never mutates its own configuration and exposes no admin API. That is ADR-007
 * extended to the deployment, and it is why this builds an image rather than
 * pushing config to a running service.
 */

/** Where the image lives. Artifact Registry, one repository per project. */
export function imageReference(cloudrun: CloudRunTarget, tag: string): string {
  return `${cloudrun.region}-docker.pkg.dev/${cloudrun.project}/lanes-link/${cloudrun.service}:${tag}`;
}

/**
 * The commands a deploy runs, as data.
 *
 * Separated from running them so `--dry-run` shows exactly what will happen and
 * so the argv construction is testable without a Google Cloud project. Every
 * value is a separate argv element; nothing is interpolated into a shell.
 */
export function deployPlan(input: PlanInput): DeployStep[] {
  const cloudrun = requireProject(input.deploy, input.target);
  const image = imageReference(cloudrun, input.tag);
  const scope = ['--project', cloudrun.project, '--region', cloudrun.region];
  // Where this package is installed, which is where the Dockerfile and the build
  // config live. Never the working directory: `lanes link deploy` is run from
  // wherever somebody happens to be standing.
  const root = installRoot(import.meta.dir);

  return [
    {
      title: 'ensure the Artifact Registry repository exists',
      argv: [
        'artifacts',
        'repositories',
        'create',
        'lanes-link',
        '--repository-format',
        'docker',
        '--location',
        cloudrun.region,
        '--project',
        cloudrun.project,
        '--description',
        'Lanes Link images',
      ],
      // Second and subsequent deploys: already there, and that is the success
      // case rather than a failure worth stopping for.
      tolerateFailure: true,
    },
    {
      title: 'build and push the image',
      argv: [
        'builds',
        'submit',
        '--project',
        cloudrun.project,
        '--config',
        join(root, 'src/deployments/gcp/cloudbuild.yaml'),
        '--substitutions',
        `_IMAGE=${image}`,
        // The build context, and the config beside it, are the *installed
        // package* — not whatever directory the operator happened to run from.
        // Both were relative, so `lanes link deploy` worked from a checkout and
        // failed everywhere else with a missing cloudbuild.yaml, which reads as
        // a broken install rather than as a wrong working directory.
        root,
      ],
    },
    {
      title: 'roll a revision',
      argv: [
        'run',
        'deploy',
        cloudrun.service,
        ...scope,
        '--image',
        image,
        '--platform',
        'managed',
        '--port',
        '8080',
        // The container reads these; everything else it needs is baked in.
        '--set-env-vars',
        [
          `LANES_LINK_TARGET=${input.target}`,
          // Unconditional: `deploy` requires --profile (ADR-037), so this is
          // always known, and a revision without it refuses at boot.
          `LANES_LINK_PROFILE=${input.profile}`,
          ...(input.workspace ? [`LANES_LINK_HOME=${input.workspace}`] : []),
        ].join(','),
        ...secretMounts(input.secretEnv),
        ...(cloudrun.service_account ? ['--service-account', cloudrun.service_account] : []),
        // `iam` is Cloud Run's own identity check, which admits only a caller
        // holding a Google-signed identity token for this service. No agent
        // harness can mint one — so a target reached by a remote MCP client
        // declares `public` and gates the request in the application instead.
        cloudrun.access === 'iam' ? '--no-allow-unauthenticated' : '--allow-unauthenticated',
        // What the platform will accept a connection from at all, which is a
        // different question from who it lets through. An `iam` target is by
        // definition not reached by an MCP client — no agent harness can mint the
        // identity token Cloud Run wants — so it is reached by other cloud
        // workloads or by nothing, and neither needs an internet-facing listener.
        // `public` is the case where the listener *is* the point.
        '--ingress',
        cloudrun.access === 'iam' ? 'internal-and-cloud-load-balancing' : 'all',
        // Always passed, including the zero and including every default below
        // it. Config is the source of truth here (ADR-004), and a flag sent only
        // when non-zero would let a value be raised and never lowered — the
        // revision would keep whatever the last deploy that bothered to mention
        // it had set.
        '--min-instances',
        String(cloudrun.min_instances),
        // The five that used to be absent, and absent meant the platform's own
        // defaults: a hundred instances, eighty concurrent requests each, and
        // 512 MiB to serve a 64 MiB upload in. Each one is argued at its field in
        // `deployTargetSchema`; what they have in common is that a public URL
        // with no ceiling on any of them is an endpoint whose cost and whose
        // credential-store traffic are decided by whoever is calling it.
        '--max-instances',
        String(cloudrun.max_instances),
        '--concurrency',
        String(cloudrun.concurrency),
        '--timeout',
        String(cloudrun.timeout_seconds),
        '--memory',
        cloudrun.memory,
        '--cpu',
        cloudrun.cpu,
        // Named rather than inherited, like the five above. gen2 is the current
        // default and the one this image is tested on; pinning it means a
        // platform migration is a commit here rather than a change under a
        // running endpoint.
        '--execution-environment',
        'gen2',
      ],
    },
  ];
}

/**
 * Environment the revision reads out of Secret Manager, as `--set-secrets`.
 *
 * The value never travels: Cloud Run is told a secret id and resolves it at
 * instance start, as the runtime service account, so the key stays out of the
 * argv this prints, out of the revision's stored description, and out of
 * anything `gcloud run services describe` returns.
 *
 * The `/` → `__` encoding is the credential adapter's, applied here rather than
 * duplicated: `vault/key` is the secret `vault__key`, and a driver that spelled
 * that itself would drift from the store that writes it.
 */
function secretMounts(secretEnv: PlanInput['secretEnv']): string[] {
  const entries = Object.entries(secretEnv ?? {});

  // `--clear-secrets`, not nothing. `gcloud run deploy` leaves a setting it is
  // not told about exactly as the last revision had it, so an empty map used to
  // mean "keep whatever is mounted" rather than "mount nothing" — and removing a
  // vault from config left its secret still resolved into the new revision's
  // environment, indefinitely, with nothing in the config saying so. The same
  // argument `--min-instances` makes about always passing the zero.
  if (entries.length === 0) return ['--clear-secrets'];

  return [
    '--set-secrets',
    entries.map(([variable, ref]) => `${variable}=${encodeRef(ref)}:latest`).join(','),
  ];
}

export const cloudRunDriver: DeployDriver = {
  platform: 'cloudrun',
  tool: 'gcloud',

  preflight() {
    // A property of *this* deployment, not of deployments generally — which is
    // why it is asked here rather than by the generic command.
    return gcloudPath()
      ? null
      : 'gcloud is not on your PATH. Install the Google Cloud CLI, run `gcloud auth login`, ' +
          'and try again — or use --dry-run to see the commands and run them yourself.';
  },

  survey(input: SurveyInput): Promise<SurveyResult> {
    return surveyCloudRun(input);
  },

  provision(input: ProvisionInput): Promise<DeployStep[]> {
    // The policy reader is what lets a deploy take away the bindings it
    // supersedes rather than only add the ones it means. It reads; it changes
    // nothing, and a `--dry-run` that skipped it would print a plan missing
    // exactly the steps this deploy exists to make visible.
    return provisionSteps(input, gcloudPolicy);
  },

  plan: deployPlan,

  url(deploy: DeployConfig): Promise<string | null> {
    // `outputs` calls this for any deployable target and must degrade rather
    // than throw: gcloud may be absent and the service may not exist yet.
    return deploy.project ? serviceUrl(deploy as CloudRunTarget) : Promise.resolve(null);
  },

  run(argv: readonly string[], options?: { quiet?: boolean }): Promise<CommandResult> {
    return options?.quiet === true ? captureGcloud(argv) : runGcloud(argv);
  },
};
