import { describe, expect, test } from 'bun:test';
import { DEPLOY_DEFAULTS, type DeployConfig, type TargetConfig } from '#profile';
import { conditionFlag, removalStep, supersededBindings, type PolicyBinding, type PolicyReader } from './iam.ts';
import { bucketGrants } from './bucket.ts';
import { provisionSteps } from './provision.ts';

/**
 * That a deploy takes away the bindings it replaced.
 *
 * `add-iam-policy-binding` adds. Change a condition's expression and the old
 * binding stays, and IAM unions the two — so three deploys in a row narrowed
 * `reads-its-config` while the revision went on holding `objectViewer` on every
 * object in the bucket, under a `title` claiming the opposite. The policy read
 * here is the only way to see that: nothing in this repository records what the
 * last deploy wrote, deliberately.
 *
 * The fixtures below are the real shapes, off a real bucket, with the names
 * changed: an `owns-its-data` from before the manifest carve-out existed, and a
 * `reads-its-config` still saying `expression=true` because the two attempts to
 * replace it were both refused by CEL and both tolerated.
 */

const BUCKET = 'lanes-link-demo-data';
const PROFILE = 'personal';
const SERVICE_ACCOUNT = 'lanes-link-run@my-project.iam.gserviceaccount.com';
const MEMBER = `serviceAccount:${SERVICE_ACCOUNT}`;

const desired = bucketGrants(BUCKET, [PROFILE]);

const stale = {
  ownsSkills: {
    role: 'roles/storage.objectAdmin',
    members: [MEMBER],
    condition: {
      title: 'owns-its-data',
      expression:
        `resource.name.startsWith("projects/_/buckets/${BUCKET}/objects/data/") || ` +
        `resource.name.startsWith("projects/_/buckets/${BUCKET}/objects/skills/")`,
    },
  },
  readsEverything: {
    role: 'roles/storage.objectViewer',
    members: [MEMBER],
    condition: { title: 'reads-its-config', expression: 'true' },
  },
} satisfies Record<string, PolicyBinding>;

/** What the desired grants look like once they are on the policy. */
const applied: PolicyBinding[] = desired.map((grant) => ({
  role: grant.role,
  members: [MEMBER],
  condition: { title: grant.title, expression: grant.expression },
}));

describe('which bindings a deploy has superseded', () => {
  test('an earlier expression under a title this deploy still writes', () => {
    const found = supersededBindings({
      current: [...applied, stale.ownsSkills, stale.readsEverything],
      member: MEMBER,
      desired,
    });

    expect(found).toEqual([stale.ownsSkills, stale.readsEverything]);
  });

  test('and not the binding this deploy just applied', () => {
    // The whole point of matching on the expression rather than the title: the
    // add and the remove run in the same list, seconds apart, and a rule that
    // could not tell them apart would take away what it had just granted.
    expect(supersededBindings({ current: applied, member: MEMBER, desired })).toEqual([]);
  });

  test('a role change carries its title with it', () => {
    // Matched on the title, so moving `owns-its-data` onto a different role
    // still cleans up the binding the old role is holding.
    const found = supersededBindings({
      current: [stale.ownsSkills],
      member: MEMBER,
      desired: [{ role: 'roles/storage.objectUser', title: 'owns-its-data', expression: 'x' }],
    });

    expect(found).toEqual([stale.ownsSkills]);
  });

  test('an unconditioned binding on a role this deploy only grants conditionally', () => {
    // No condition at all is the whole bucket, which is the state the condition
    // exists to prevent — there is no version of this deploy that meant it.
    const blanket: PolicyBinding = { role: 'roles/storage.objectAdmin', members: [MEMBER] };

    expect(supersededBindings({ current: [blanket], member: MEMBER, desired })).toEqual([blanket]);
  });

  test('nothing belonging to another member', () => {
    const someoneElse: PolicyBinding = {
      ...stale.readsEverything,
      members: ['user:someone@example.com'],
    };

    expect(supersededBindings({ current: [someoneElse], member: MEMBER, desired })).toEqual([]);
  });

  test('nothing on a role this deploy does not grant', () => {
    // A bucket's policy carries `legacyBucketOwner`, `legacyObjectReader` and
    // whatever the operator added. A deploy owns the bindings it writes and
    // nothing else on the resource.
    const legacy: PolicyBinding = { role: 'roles/storage.legacyBucketOwner', members: [MEMBER] };

    expect(supersededBindings({ current: [legacy], member: MEMBER, desired })).toEqual([]);
  });
});

describe('naming the binding to remove, exactly', () => {
  test('title and expression, comma-delimited like the add', () => {
    const flag = conditionFlag(stale.readsEverything.condition);

    expect(flag).toBe('title=reads-its-config,expression=true');
  });

  test('a description is part of the match, so it has to be carried', () => {
    // gcloud removes "only a binding with a condition that exactly matches the
    // specified condition (including the optional description)". Dropping it
    // removes nothing, and reports removing nothing as success.
    expect(conditionFlag({ title: 't', expression: 'e', description: 'why' })).toBe(
      'title=t,expression=e,description=why',
    );
  });

  test('an expression containing a comma switches delimiter rather than splitting', () => {
    // gcloud parses this value as comma-separated key=value pairs, so a comma
    // inside the expression silently becomes a third key.
    const flag = conditionFlag({ title: 't', expression: 'f(a, b)' });

    expect(flag).toBe('^;^title=t;expression=f(a, b)');
    expect(flag.split(',').length).toBeGreaterThan(1);
  });

  test('a condition no delimiter can express is left in place rather than approximated', () => {
    // An argv that does not mean the binding either removes nothing or removes
    // something else. Leaving it is the safe half of that choice.
    const impossible = { title: 't', expression: ',;:#~%' };

    expect(conditionFlag(impossible)).toBe('');
    expect(
      removalStep({ resource: ['x'], member: MEMBER, binding: { condition: impossible }, title: 't' }),
    ).toBeNull();
  });

  test('an unconditioned binding is removed by naming no condition', () => {
    const step = removalStep({
      resource: ['storage', 'buckets', 'remove-iam-policy-binding', `gs://${BUCKET}`],
      member: MEMBER,
      binding: { role: 'roles/storage.objectAdmin', members: [MEMBER] },
      title: 'drop it',
    })!;

    // `--condition=None` is gcloud's spelling for "the binding without one".
    expect(step.argv[step.argv.indexOf('--condition') + 1]).toBe('None');
    expect(step.removes).toBe(true);
    expect(step.tolerateFailure).toBe(true);
  });
});

const cloudrun = {
  platform: 'cloudrun',
  project: 'my-project',
  region: 'europe-west1',
  service: 'lanes-link',
  access: 'public',
  service_account: SERVICE_ACCOUNT,
  min_instances: 0,
  ...DEPLOY_DEFAULTS,
} as const satisfies DeployConfig;

const target: TargetConfig = {
  credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
  storage: { adapter: 'gcs', bucket: BUCKET },
} as TargetConfig;

/** A policy reader answering with whatever a test hands it. */
const reading = (input: {
  bucket?: readonly PolicyBinding[] | null;
  project?: readonly PolicyBinding[] | null;
}): PolicyReader => ({
  bucket: () => Promise.resolve(input.bucket ?? []),
  project: () => Promise.resolve(input.project ?? []),
});

const plan = (policy?: PolicyReader, readable: readonly string[] = ['profile/token']) =>
  provisionSteps(
    {
      deploy: cloudrun,
      declared: target,
      target: 'cloud',
      readable,
      profiles: [PROFILE],
    },
    policy,
  );

describe('a deploy against a bucket carrying both generations', () => {
  const current = [...applied, stale.ownsSkills, stale.readsEverything];

  test('removes each superseded binding, naming its own expression', async () => {
    const removals = (await plan(reading({ bucket: current }))).filter(
      (step) => step.argv[1] === 'buckets' && step.argv[2] === 'remove-iam-policy-binding',
    );

    expect(removals).toHaveLength(2);
    expect(removals.map((step) => step.argv[step.argv.indexOf('--condition') + 1])).toEqual([
      `title=owns-its-data,expression=${stale.ownsSkills.condition.expression}`,
      'title=reads-its-config,expression=true',
    ]);
  });

  test('after the additions, never before them', async () => {
    // The two are one edit to a live policy. Removing first opens a window —
    // seconds by the clock, longer once propagation is counted — in which the
    // revision currently serving requests holds no grant at all.
    const steps = await plan(reading({ bucket: current }));
    const lastAdd = steps.findLastIndex((step) => step.argv[2] === 'add-iam-policy-binding');
    const firstRemoval = steps.findIndex((step) => step.argv[2] === 'remove-iam-policy-binding');

    expect(firstRemoval).toBeGreaterThan(lastAdd);
  });

  test('plans no removal at all when the policy could not be read', async () => {
    // A missing gcloud, a bucket that does not exist yet, a login that may not
    // read the policy: all "could not look", and none of them a reason to guess
    // at what to take away.
    const steps = await plan(reading({ bucket: null, project: null }));

    expect(steps.filter((step) => step.argv.includes('remove-iam-policy-binding'))).toEqual([]);
  });

  test('and none when nobody asked, which is what every other test of this file does', async () => {
    expect((await plan()).filter((step) => step.argv[2] === 'remove-iam-policy-binding')).toEqual([]);
  });
});

describe('the project-wide secret read the per-secret grants replaced', () => {
  const projectWide: PolicyBinding = {
    role: 'roles/secretmanager.secretAccessor',
    members: [MEMBER],
  };

  test('is removed once read is granted per secret', async () => {
    // This is what made the outage partial and therefore slow to find: a
    // connection made after a deploy had no per-secret grant, and this binding
    // covered the read anyway — so it authorised, answered, and reported
    // `active` until the first refresh needed a write.
    const step = (await plan(reading({ project: [projectWide] }))).find(
      (candidate) => candidate.argv[0] === 'projects' && candidate.argv[1] === 'remove-iam-policy-binding',
    )!;

    expect(step.argv).toContain('roles/secretmanager.secretAccessor');
    expect(step.argv).toContain(MEMBER);
    // Irrespective of any condition: every shape of it is one an earlier version
    // of this file wrote.
    expect(step.argv).toContain('--all');
    expect(step.removes).toBe(true);
  });

  test('is not removed when this run granted nothing per secret', async () => {
    // With no readable set there is nothing to fall back to, and taking away the
    // only grant the revision holds would be an outage caused by tidying.
    const steps = await plan(reading({ project: [projectWide] }), []);

    expect(steps.filter((step) => step.argv[0] === 'projects')).toEqual([]);
  });

  test('is not mentioned at all when it is not there', async () => {
    // Every deploy after the one that removed it. A step that reports "already
    // gone" on every run teaches an operator to skim the output.
    const steps = await plan(reading({ project: [] }));

    expect(steps.filter((step) => step.argv.includes('remove-iam-policy-binding'))).toEqual([]);
  });
});

describe('a binding cannot attach to a secret that does not exist', () => {
  const created = (steps: { argv: readonly string[] }[]) =>
    steps.filter((step) => step.argv[0] === 'secrets' && step.argv[1] === 'create').map((step) => step.argv[2]);

  test('the secrets a revision only reads are created here too', async () => {
    // `prepareSecrets` mints the endpoint's own bearer token *after*
    // provisioning, so on a first deploy the secret appeared a step too late to
    // be bound: gcloud answered NOT_FOUND, the step tolerated it, and the
    // revision could not read the one value it refuses to start without. A
    // second deploy fixed it, which is why it survived.
    expect(created(await plan())).toEqual(['profile__token']);
  });

  test('a ref that is both read and rotated is created once', async () => {
    const steps = await provisionSteps({
      deploy: cloudrun,
      declared: target,
      target: 'cloud',
      readable: ['gmail/ada_lovelace', 'profile/token'],
      rotatable: ['gmail/ada_lovelace'],
      profiles: [PROFILE],
    });

    expect(created(steps)).toEqual(['gmail__ada_lovelace', 'profile__token']);
  });
});
