import { join } from 'node:path';
import { installRoot, layout } from '#profile';
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
  /**
   * The bucket itself, which is a different resource from anything in it.
   *
   * **`storage.objects.list` is checked against the bucket, never against an
   * object**, so no condition written in terms of `objects/…` can ever grant it
   * — including a prefixed listing, which is one call with a filter rather than
   * a walk of matching resources. Google says so outright: IAM conditions cannot
   * restrict listing by prefix.
   *
   * This was invisible until the day the narrowing actually applied. The
   * `reads-its-config` binding had been sitting at `expression=true` since the
   * first deploy, and `true` matches the bucket resource as readily as an object
   * — so listing worked, and every deploy that thought it had replaced that
   * binding had in fact only added one beside it. The first deploy that removed
   * the old one rolled a revision that could not list its own workspace, exited
   * 1, and took the endpoint's listing with it: `objects.list` had never been
   * granted by anything else.
   *
   * Only `storage.objects.list` can come of it. Every other permission in
   * `objectViewer` is either evaluated against an object — where the prefixes
   * below still decide — or is a project-level permission a binding on a bucket
   * does not reach. So the concession is the names of the objects in this
   * bucket, and reads stay scoped to the config.
   */
  const theBucket = `resource.name == "projects/_/buckets/${bucket}"`;

  // One prefix, not one per profile. Manifests are the workspace's since
  // ADR-057 — a manifest defines a connection, and connections do not live in a
  // profile — so the carve-out no longer varies with the profile set.
  const manifestPrefixes = [objectsUnder(`${layout.providers()}/`)];
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
      expression: `${theBucket} || ${objectsUnder('profiles/')} || ${objectIs('lanes-link.yaml')}${manifests ? ` || ${manifests}` : ''}`,
    },
  ];
}

/**
 * How long a deleted or overwritten object can still be recovered.
 *
 * The revision holds `objectAdmin` on everything under `data/`, and
 * `objectAdmin` contains `storage.objects.delete`. That grant is correct — the
 * endpoint writes state, memory, tasks, assets and the audit log, and rewriting
 * an object is deleting the old one — but it means the process most exposed to
 * the internet is also the one that can erase the record of what it did.
 * `audit.tamper-evident` already says deleting a run whole is not *detectable*;
 * without this it was not *recoverable* either.
 *
 * Thirty days rather than the platform's default seven, because the gap this
 * closes is noticing late. A compromise found the same afternoon needs no
 * retention policy at all.
 */
const SOFT_DELETE_DURATION = '30d';

/**
 * The three protections a deploy applies to the bucket every time it runs.
 *
 * `update` rather than flags on `create`, so they reach a bucket that already
 * exists — see the call site. Idempotent: setting a policy to what it already is
 * is a no-op that costs one API call.
 *
 * - **Public access prevention**, enforced. Nothing in this bucket is served to
 *   a browser and nothing in it should ever be anonymous-readable, so the useful
 *   setting is the one that makes granting that impossible rather than merely
 *   absent. Uniform bucket-level access already removes per-object ACLs; this
 *   removes the bucket-level way to do the same thing.
 * - **Soft delete**, so a deletion is recoverable — see above.
 * - **Object versioning**, with the lifecycle rule that bounds it. Versioning
 *   covers what soft delete does not: an object *overwritten* in place, where
 *   the previous content is the thing worth keeping. The rule is a file shipped
 *   beside this one rather than written at plan time, because `--dry-run` writes
 *   nothing and prints what it would run — a temporary file would break both.
 */
function durabilitySteps(bucket: string): DeployStep[] {
  const lifecycle = join(installRoot(import.meta.dir), 'src/deployments/gcp/lifecycle.json');

  return [
    {
      title: 'make the bucket unable to be shared publicly, and its deletions recoverable',
      argv: [
        'storage',
        'buckets',
        'update',
        `gs://${bucket}`,
        '--public-access-prevention',
        '--soft-delete-duration',
        SOFT_DELETE_DURATION,
        '--versioning',
        // Without this, versioning keeps every prior copy of every state key
        // forever, and state is the one thing here that is rewritten rather than
        // appended. The rule bounds it by age and by count.
        '--lifecycle-file',
        lifecycle,
      ],
      tolerateFailure: true,
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
        // Autoclass rather than a storage-class lifecycle rule, because no one
        // fixed class is right for this bucket: it holds the config the endpoint
        // reads on every boot next to assets and audit rows nobody opens again.
        // Inside an Autoclass bucket there are no retrieval and no
        // early-deletion fees, which is what makes ARCHIVE safe as the floor
        // rather than a bet on never reading the thing again — a read pulls the
        // object back to Standard at no charge. Objects under 128 KiB never
        // leave Standard, so this costs the config and the log nothing and saves
        // on attachments.
        '--enable-autoclass',
        '--autoclass-terminal-storage-class',
        'ARCHIVE',
      ],
      tolerateFailure: true,
    },
    // Everything about durability, applied separately from the create.
    //
    // **Not folded into the flags above, and that is the whole point.** Every
    // step here tolerates failure, so the create is refused as `ALREADY_EXISTS`
    // on the second deploy onwards — which means a protection added to that
    // argv reaches a bucket made after this commit and no other. Every
    // deployment that already exists is exactly the one that has an audit log
    // worth keeping.
    ...durabilitySteps(input.bucket),
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
