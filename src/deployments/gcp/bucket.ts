import { layout } from '#profile';
import type { DeployStep } from '../driver.ts';
import {
  removalStep,
  supersededBindings,
  type ConditionedGrant,
  type PolicyReader,
} from './iam.ts';

/**
 * The bucket a deployed target keeps everything in, and who may touch what in it.
 *
 * Split out of `provision.ts` because it is a different subject from the rest of
 * that file. Everything else there is "create the thing this deploy needs";
 * this is one resource's access policy, and it is the only place in the
 * repository where ADR-007 is enforced by something other than the code being
 * unable to write.
 *
 * Two conditioned bindings rather than one blanket `objectAdmin`, because the
 * bucket now holds the config as well as the data. ADR-007 says a deployed
 * instance never mutates its own configuration. That used to be enforced by the
 * image being read-only, which stopped being true when the workspace moved into
 * the bucket (ADR-023). This is where the guarantee went: the revision may write
 * what it owns and may only read what declares what it is.
 */

/**
 * The two grants, as data, so the same list drives what is added and what is
 * recognised as an earlier version of itself.
 *
 * A provider manifest is configuration that happens to live inside the profile's
 * directory (ADR-030), so `data/` alone no longer separates what the revision
 * owns from what declares what it is.
 *
 * **One `startsWith` per profile, because Cloud Storage IAM conditions cannot
 * express anything else.** Their CEL is a restricted subset — `resource.type`,
 * `resource.name` with `startsWith`/`endsWith`/`==`, and the date functions —
 * and it has no `matches`. This was a regex, and it was refused twice over:
 * first because it spelled the dot `\.`, which is not a CEL escape, so the
 * string literal would not parse; then, with that fixed, because `matches` is
 * `undeclared` in this dialect.
 *
 * Enumerating the served profiles is expressible in the subset that does exist,
 * and it makes `grants.test.ts` honest as a side effect: that file evaluates
 * these as JavaScript, where `startsWith` means what it means here and `matches`
 * quietly did not.
 */
export function bucketGrants(bucket: string, profiles: readonly string[]): ConditionedGrant[] {
  const objectsUnder = (path: string): string =>
    `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${path}")`;
  const objectIs = (path: string): string =>
    `resource.name == "projects/_/buckets/${bucket}/objects/${path}"`;

  const manifestPrefixes = profiles.map((profile) =>
    objectsUnder(`${layout.providers(profile)}/`),
  );
  // No profiles leaves the carve-out off rather than guessing at one: the
  // revision keeps write on its own data, as it did before this existed.
  const manifests = manifestPrefixes.length > 0 ? `(${manifestPrefixes.join(' || ')})` : null;

  return [
    {
      // objectAdmin, not objectViewer: state, the log, attachments, memory and
      // skills are all written by the running endpoint.
      role: 'roles/storage.objectAdmin',
      title: 'owns-its-data',
      expression: `${objectsUnder('data/')}${manifests ? ` && !${manifests}` : ''}`,
    },
    {
      // `expression=true` was here, which is every object in the bucket — the
      // step title and ADR-023 both claim a narrowing this did not do. The
      // config the revision reads is the workspace file, the profiles beside it,
      // and each profile's own manifests, so name exactly those.
      role: 'roles/storage.objectViewer',
      title: 'reads-its-config',
      expression: `${objectsUnder('profiles/')} || ${objectIs('lanes-link.yaml')}${manifests ? ` || ${manifests}` : ''}`,
    },
  ];
}

const TITLES: Record<string, string> = {
  'owns-its-data': 'let the revision write its own data, but not the manifests in it',
  'reads-its-config': 'let the revision read its config, and only read it',
};

/** Everything a deploy does to the bucket: create it, grant, and un-grant. */
export async function bucketSteps(input: {
  readonly bucket: string;
  readonly project: string;
  readonly region: string;
  readonly serviceAccount: string | undefined;
  readonly profiles: readonly string[];
  readonly policy?: PolicyReader | undefined;
}): Promise<DeployStep[]> {
  const steps: DeployStep[] = [
    {
      title: `create the bucket gs://${input.bucket}`,
      argv: [
        'storage',
        'buckets',
        'create',
        `gs://${input.bucket}`,
        '--project',
        input.project,
        '--location',
        input.region,
        // Blobs here are read and written by one instance at a time and never
        // served publicly; uniform access removes per-object ACLs as a way to
        // get that wrong.
        '--uniform-bucket-level-access',
      ],
      tolerateFailure: true,
    },
  ];

  if (!input.serviceAccount) return steps;

  const member = `serviceAccount:${input.serviceAccount}`;
  const grants = bucketGrants(input.bucket, input.profiles);

  for (const grant of grants) {
    steps.push({
      title: TITLES[grant.title] ?? `bind ${grant.role}`,
      argv: [
        'storage',
        'buckets',
        'add-iam-policy-binding',
        `gs://${input.bucket}`,
        '--member',
        member,
        '--role',
        grant.role,
        '--condition',
        `title=${grant.title},expression=${grant.expression}`,
      ],
      tolerateFailure: true,
    });
  }

  // After the additions above, and only ever after them — see `removalStep`.
  const current = (await input.policy?.bucket(input.bucket)) ?? null;
  if (current === null) return steps;

  for (const binding of supersededBindings({ current, member, desired: grants })) {
    const step = removalStep({
      resource: ['storage', 'buckets', 'remove-iam-policy-binding', `gs://${input.bucket}`],
      member,
      binding,
      title: binding.condition
        ? `drop the superseded "${binding.condition.title}" binding an earlier deploy left`
        : `drop the unconditioned ${binding.role} an earlier deploy left`,
    });
    if (step) steps.push(step);
  }

  return steps;
}
