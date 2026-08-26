import { describe, expect, test } from 'bun:test';
import type { DeployConfig, TargetConfig } from '#profile';
import { cloudRunDriver, deployPlan, imageReference } from './driver.ts';
import { provisionSteps } from './provision.ts';

/**
 * What a deploy runs, asserted as data.
 *
 * `lanes link deploy` is a wrapper around `gcloud`, so the thing that can be wrong
 * about it is the argv it builds — and that is exactly the part a live deploy
 * verifies slowest and most expensively. `--dry-run` prints these same steps.
 */

const cloudrun = {
  platform: 'cloudrun',
  project: 'my-project',
  region: 'europe-west1',
  service: 'lanes-link',
  access: 'iam',
  min_instances: 0,
} as const satisfies DeployConfig;

const plan = (overrides: Partial<DeployConfig> = {}, rest: { profile?: string } = {}) =>
  deployPlan({
    deploy: { ...cloudrun, ...overrides },
    tag: '20260811T090000',
    target: 'cloud',
    profile: 'personal',
    ...rest,
  });

const rollout = (overrides: Partial<DeployConfig> = {}, rest: { profile?: string } = {}) =>
  plan(overrides, rest).find((step) => step.argv[0] === 'run')!;

describe('the image reference', () => {
  test('names an Artifact Registry repository in the service region', () => {
    expect(imageReference({ ...cloudrun }, 'abc')).toBe(
      'europe-west1-docker.pkg.dev/my-project/lanes-link/lanes-link:abc',
    );
  });

  test('the same reference reaches the build and the revision', () => {
    const steps = plan();
    const build = steps.find((step) => step.argv[0] === 'builds')!;
    const deploy = steps.find((step) => step.argv[0] === 'run')!;

    // A build that pushes one tag and a revision that pulls another is a deploy
    // that silently serves the previous image.
    const image = imageReference({ ...cloudrun }, '20260811T090000');
    expect(build.argv).toContain(`_IMAGE=${image}`);
    expect(deploy.argv[deploy.argv.indexOf('--image') + 1]).toBe(image);
  });
});

describe('the steps', () => {
  test('creates the registry repository, builds, then rolls a revision, in that order', () => {
    expect(plan().map((step) => step.argv.slice(0, 2).join(' '))).toEqual([
      'artifacts repositories',
      'builds submit',
      'run deploy',
    ]);
  });

  test('an existing repository is not a failure', () => {
    // Every deploy after the first hits ALREADY_EXISTS here.
    expect(plan()[0]?.tolerateFailure).toBe(true);
    expect(plan()[1]?.tolerateFailure).toBeUndefined();
  });

  test('the build names the Dockerfile through a build config', () => {
    // `gcloud builds submit --tag` always builds ./Dockerfile, and this one
    // lives under src/deployments/gcp/.
    const build = plan().find((step) => step.argv[0] === 'builds')!;
    expect(build.argv).toContain('src/deployments/gcp/cloudbuild.yaml');
    expect(build.argv.at(-1)).toBe('.');
  });

  test('the revision is told which target to open', () => {
    const env = rollout().argv[rollout().argv.indexOf('--set-env-vars') + 1];

    // The one thing that differs between running locally and running deployed —
    // now always accompanied by the profile, which a revision also cannot do
    // without.
    expect(env).toBe('LANES_LINK_TARGET=cloud,LANES_LINK_PROFILE=personal');
  });

  test('the profile is always carried into the revision', () => {
    // It used to be conditional on `--profile` having been passed, and deploying
    // without it was the documented common case — so a large share of existing
    // services carry no LANES_LINK_PROFILE at all, and a container that reads no
    // workspace default refuses at boot. `deploy` names a profile now, so this
    // is always known and always sent.
    const withProfile = rollout({}, { profile: 'work' });
    const env = withProfile.argv[withProfile.argv.indexOf('--set-env-vars') + 1];
    expect(env).toBe('LANES_LINK_TARGET=cloud,LANES_LINK_PROFILE=work');

    expect(rollout().argv.join(' ')).toContain('LANES_LINK_PROFILE=personal');
  });

  test('a deploy block with no project is refused by the driver, not by the schema', () => {
    // `project` is optional in the schema because it means nothing to a platform
    // without projects. The driver that needs it is the thing that says so.
    const { project: _project, ...withoutProject } = cloudrun;
    expect(() =>
      deployPlan({
        deploy: withoutProject as DeployConfig,
        tag: 't',
        target: 'cloud',
        profile: 'personal',
      }),
    ).toThrow(/targets\.cloud\.deploy\.project is required/);
  });
});

describe('who can reach the endpoint', () => {
  test('access: iam closes the platform door', () => {
    const deploy = rollout({ access: 'iam' });
    expect(deploy.argv).toContain('--no-allow-unauthenticated');
    expect(deploy.argv).not.toContain('--allow-unauthenticated');
  });

  test('access: public leaves it open for this endpoint to authenticate', () => {
    // Not a weaker deployment — a different layer. Cloud Run IAM admits only a
    // caller holding a Google-signed identity token for this service, which no
    // agent harness can mint, so a target a remote MCP client has to reach
    // declares `public` and gates the request in the application instead.
    const deploy = rollout({ access: 'public' });
    expect(deploy.argv).toContain('--allow-unauthenticated');
    expect(deploy.argv).not.toContain('--no-allow-unauthenticated');
  });

  test('scaling is stated on every rollout, including the zero', () => {
    // Sent unconditionally so config is what decides. A flag passed only when
    // non-zero would let the value be raised and never lowered — the revision
    // would keep whatever the last deploy that bothered to mention it set, and
    // a target reading `min_instances: 0` would go on billing for an instance.
    expect(plan().find((step) => step.title === 'roll a revision')?.argv).toContain('--min-instances');
    expect(plan().find((step) => step.title === 'roll a revision')?.argv).toContain('0');
    expect(plan({ min_instances: 2 }).find((step) => step.title === 'roll a revision')?.argv).toContain('2');
  });

  test('secret-backed environment is mounted by reference, never by value', () => {
    // The key itself must not reach this argv: `--dry-run` prints it, the
    // platform echoes it, and a revision keeps its description forever. Cloud
    // Run is told a secret id and resolves it at instance start, as the runtime
    // service account.
    const deploy = deployPlan({
      deploy: { ...cloudrun },
      tag: 't',
      target: 'cloud',
      profile: 'personal',
      secretEnv: { LANES_LINK_VAULT_KEY: 'vault/key' },
    }).find((step) => step.argv[0] === 'run')!;

    // `/` is not legal in a Secret Manager id; the store encodes it as `__`.
    expect(deploy.argv[deploy.argv.indexOf('--set-secrets') + 1]).toBe(
      'LANES_LINK_VAULT_KEY=vault__key:latest',
    );
  });

  test('no --set-secrets at all for a target that needs none', () => {
    expect(rollout().argv).not.toContain('--set-secrets');
  });

  test('a service account is passed through, and omitted when not given', () => {
    const withAccount = rollout({ service_account: 'link@my-project.iam.gserviceaccount.com' });
    expect(withAccount.argv[withAccount.argv.indexOf('--service-account') + 1]).toBe(
      'link@my-project.iam.gserviceaccount.com',
    );
    expect(rollout().argv).not.toContain('--service-account');
  });
});

describe('argument construction', () => {
  test('a config value stays one argument and cannot smuggle a flag', () => {
    // argv arrays, never a shell string: a service name carrying whitespace
    // and a flag is one element that `gcloud` rejects as a bad name, rather
    // than an extra option it happily obeys.
    const deploy = rollout({ service: 'svc --allow-unauthenticated', access: 'iam' });

    expect(deploy.argv).toContain('svc --allow-unauthenticated');
    expect(deploy.argv).not.toContain('--allow-unauthenticated');
    expect(deploy.argv).toContain('--no-allow-unauthenticated');
  });

  test('every step names the project, so an active gcloud config cannot redirect it', () => {
    // `gcloud config set project` is sticky and invisible; deploying a personal
    // instance into whatever project was last selected is the failure it causes.
    for (const step of plan()) {
      expect(step.argv[step.argv.indexOf('--project') + 1]).toBe('my-project');
    }
  });
});

describe('first-run provisioning', () => {
  const target = (storage: TargetConfig['storage']): TargetConfig =>
    ({
      credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
      storage,
    }) as TargetConfig;

  const provision = (
    storage: TargetConfig['storage'] = { adapter: 's3', bucket: 'lanes-link-blobs' },
    deploy: Partial<DeployConfig> = {},
    readable: readonly string[] = ['profile/token'],
  ) =>
    provisionSteps({
      deploy: { ...cloudrun, service_account: 'lanes-link-run@my-project.iam.gserviceaccount.com', ...deploy },
      declared: target(storage),
      target: 'cloud',
      readable,
    });

  test('every step tolerates failure, because the second deploy finds them all present', async () => {
    for (const step of await provision()) expect(step.tolerateFailure).toBe(true);
  });

  test('the APIs a deploy actually uses are enabled together', async () => {
    const step = (await provision()).find((candidate) => candidate.argv[0] === 'services')!;

    // Cloud Build especially: without it `gcloud builds submit` fails with a
    // permission error rather than a "not enabled" one, which reads as a
    // broken account rather than a missing switch.
    expect(step.argv).toContain('run.googleapis.com');
    expect(step.argv).toContain('cloudbuild.googleapis.com');
    expect(step.argv).toContain('artifactregistry.googleapis.com');
    expect(step.argv).toContain('secretmanager.googleapis.com');
    expect(step.argv[step.argv.indexOf('--project') + 1]).toBe('my-project');
  });

  test('every API a later step needs is enabled by the step that enables APIs', async () => {
    // These two were missing, and every step here tolerates failure — so
    // creating the service account and binding its role failed *silently* in a
    // project without them. The deploy carried on and rolled a revision with no
    // identity, and the first symptom was that revision failing to read a
    // secret, minutes later and nowhere near the cause.
    const steps = await provision();
    const enabled = steps.find((candidate) => candidate.argv[0] === 'services')!.argv;

    expect(enabled).toContain('iam.googleapis.com');
    expect(enabled).toContain('cloudresourcemanager.googleapis.com');

    // And it is genuinely first: an enable that runs after its dependants is
    // the same bug wearing the fix.
    expect(steps[0]?.argv[0]).toBe('services');
  });

  test('the service account is created by id, not by address', async () => {
    // Passing the whole address creates `foo@bar.iam...@project.iam...`, which
    // then fails every binding with a name that looks almost right.
    const step = (await provision()).find((candidate) => candidate.argv[1] === 'service-accounts')!;
    expect(step.argv[3]).toBe('lanes-link-run');
  });

  test('the revision is granted exactly what it needs to boot and no more', async () => {
    const roles = (await provision())
      .flatMap((step) => step.argv)
      .filter((argument) => argument.startsWith('roles/'));

    expect(roles).toEqual([
      'roles/secretmanager.secretAccessor',
      'roles/storage.objectAdmin',
      'roles/storage.objectViewer',
    ]);
  });

  test('the config binding names the config, rather than matching everything', async () => {
    // `expression=true` was here, under a condition titled `reads-its-config`.
    // It matches every object in the bucket, so the step title, the condition
    // title and ADR-023 all described a narrowing that was not happening.
    const condition = (await provision())
      .filter((step) => step.argv.includes('--condition'))
      .map((step) => step.argv[step.argv.indexOf('--condition') + 1]!)
      .find((candidate) => candidate.includes('reads-its-config'))!;

    expect(condition).not.toContain('expression=true');
    expect(condition).toContain('/objects/profiles/');
    expect(condition).toContain('/objects/lanes-link.yaml');
    // It does reach into `data/` now, for the manifests ADR-030 moved in there
    // — but by the anchored pattern only. A blanket `startsWith(".../data/")`
    // here would hand the revision read on every credential-adjacent object in
    // the profile, which is the narrowing this condition exists to make.
    expect(condition).toContain('providers\\.d/');
    expect(condition).not.toMatch(/startsWith\("[^"]*\/objects\/data\/"\)/);
  });

  test('the revision may write its data but only read its config', async () => {
    // ADR-007 says a deployed instance never mutates its own configuration.
    // That was enforced by the image being read-only until the workspace moved
    // into the bucket (ADR-023); this binding is where the guarantee went, so
    // a blanket objectAdmin would silently undo it.
    const conditions = (await provision())
      .filter((step) => step.argv.includes('--condition'))
      .map((step) => step.argv[step.argv.indexOf('--condition') + 1]!);

    const write = conditions.find((condition) => condition.includes('owns-its-data'))!;
    expect(write).toContain('/objects/data/');
    // Skills are inside `data/` since ADR-030 rather than beside it, so there
    // is no second prefix to grant.
    expect(write).not.toContain('/objects/skills/');
    // The config paths are conspicuously absent from the writable set — and
    // that now includes the manifests living inside the tree this grants, which
    // is why the expression carries a negation at all.
    expect(write).not.toContain('profiles/');
    expect(write).not.toContain('lanes-link.yaml');
    expect(write).toContain('!resource.name.matches(');
    expect(write).toContain('providers\\.d/');

    expect(conditions.some((condition) => condition.includes('reads-its-config'))).toBe(true);
  });

  test('a gcs target gets a bucket, the same as an s3 one', async () => {
    // Deployed, every target addresses a bucket: config, state, the log,
    // memory, skills, manifests and attachments are all objects in it.
    const steps = await provision({ adapter: 'gcs', bucket: 'lanes-link-blobs' });
    expect(steps.flatMap((step) => step.argv)).toContain('buckets');
  });

  test('no bucket is created for a target that declares no object storage', async () => {
    // Creating one it will never open is a resource nobody asked for and
    // nobody deletes.
    const steps = await provision({ adapter: 'filesystem' });
    expect(steps.flatMap((step) => step.argv)).not.toContain('buckets');
  });

  test('nothing is granted to a service account the target does not declare', async () => {
    const steps = await provision({ adapter: 's3', bucket: 'b' }, { service_account: undefined });
    expect(steps.flatMap((step) => step.argv).filter((a) => a.startsWith('roles/'))).toEqual([]);
  });
});

describe('the driver', () => {
  test('declares the platform it is registered under and the tool it drives', () => {
    // `drivers.ts` maps a platform to this object; a mismatch would dispatch
    // correctly and then print the wrong command in a --dry-run plan.
    expect(cloudRunDriver.platform).toBe('cloudrun');
    expect(cloudRunDriver.tool).toBe('gcloud');
  });

  test('a URL is not asked for when the block names no project', async () => {
    // `outputs` calls this for any deployable target and must degrade rather
    // than throw.
    const { project: _project, ...withoutProject } = cloudrun;
    expect(await cloudRunDriver.url(withoutProject as DeployConfig)).toBeNull();
  });
});
