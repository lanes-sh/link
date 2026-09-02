import { describe, expect, test } from 'bun:test';
import {
  CONNECTIONS_FILE,
  DEPLOY_DEFAULTS,
  WORKSPACE_FILE,
  type DeployConfig,
  type TargetConfig,
} from '#profile';
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
  ...DEPLOY_DEFAULTS,
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

  test('the build names the Dockerfile through a build config, in the install', () => {
    // `gcloud builds submit --tag` always builds ./Dockerfile, and this one
    // lives under src/deployments/gcp/.
    //
    // Absolute, and rooted at the installed package rather than the working
    // directory. Both were relative, so a deploy worked from a checkout and
    // failed everywhere else with a missing cloudbuild.yaml — which reads as a
    // broken install rather than as a wrong cwd.
    const build = plan().find((step) => step.argv[0] === 'builds')!;
    const config = build.argv[build.argv.indexOf('--config') + 1]!;
    const context = build.argv.at(-1)!;

    expect(config).toEndWith('src/deployments/gcp/cloudbuild.yaml');
    expect(config).toStartWith('/');
    expect(context).toStartWith('/');
    expect(config).toStartWith(context);
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

  test('a target that needs no secret clears the mounts rather than omitting the flag', () => {
    // Omitting it is not "mount nothing" — `gcloud run deploy` leaves a setting
    // it is not told about exactly as the previous revision had it. So removing
    // a vault from config used to leave its secret resolved into the new
    // revision's environment indefinitely, with nothing in the config saying so.
    expect(rollout().argv).not.toContain('--set-secrets');
    expect(rollout().argv).toContain('--clear-secrets');
  });

  test('the ceilings are stated on every rollout, at their defaults', () => {
    // Absent, each of these fell to a platform default: a hundred instances,
    // eighty concurrent requests each, and 512 MiB to stage a 64 MiB upload in.
    // On a `public` target those defaults are what an unauthenticated caller
    // gets to spend, so they are config here and always sent — same argument
    // `--min-instances` makes about passing the zero.
    const argv = rollout().argv;
    const valueOf = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

    expect(valueOf('--max-instances')).toBe('4');
    expect(valueOf('--concurrency')).toBe('40');
    expect(valueOf('--timeout')).toBe('300');
    expect(valueOf('--memory')).toBe('1Gi');
    expect(valueOf('--cpu')).toBe('1');
    expect(valueOf('--execution-environment')).toBe('gen2');
  });

  test('a raised ceiling is what gets sent', () => {
    const argv = rollout({ max_instances: 20, memory: '2Gi' }).argv;
    expect(argv[argv.indexOf('--max-instances') + 1]).toBe('20');
    expect(argv[argv.indexOf('--memory') + 1]).toBe('2Gi');
  });

  test('ingress follows access, so an iam target has no internet-facing listener', () => {
    // An `iam` target cannot be reached by an MCP client at all — no agent
    // harness can mint the identity token Cloud Run wants — so the listener it
    // would present to the internet answers nobody and is one more thing to
    // probe.
    const closed = rollout({ access: 'iam' }).argv;
    expect(closed[closed.indexOf('--ingress') + 1]).toBe('internal-and-cloud-load-balancing');

    const open = rollout({ access: 'public' }).argv;
    expect(open[open.indexOf('--ingress') + 1]).toBe('all');
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
      profiles: ['personal'],
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
    expect(condition).toContain(`/objects/${WORKSPACE_FILE}`);
    // **Every file the uploader writes to the workspace root belongs here**, and
    // `connections.yaml` did not. ADR-057 moved connections out of the profile
    // and `readConnections` runs at load, so a revision that cannot read it
    // resolves no grant at all: it exited 1 with `GCS refused to read
    // "connections.yaml" (403)` and never listened on its port. The build was
    // green — the condition is a string assembled in `bucket.ts` and this is the
    // only place that reads it back. Named by the constants for that reason: a
    // rename must not be able to pass here and fail in Cloud Run.
    expect(condition).toContain(`/objects/${CONNECTIONS_FILE}`);
    // The manifests, by their own anchored prefix. Not `matches`: Cloud
    // Storage IAM conditions have no such function and refused the whole
    // expression — and the binding carries `tolerateFailure`, so the narrowing
    // silently did not apply and the bucket kept whatever it already had.
    expect(condition).toContain('/objects/providers.d/');
    expect(condition).not.toContain('matches(');
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

    // **An allowlist, not `data/` minus exceptions.** There is no `data/`
    // (ADR-067), and naming what a revision may write is the better shape
    // anyway: a denylist grows silently every time something new lands under
    // the prefix it grants.
    for (const prefix of ['/objects/audit.log/', '/objects/state.kv/', '/objects/credentials.enc']) {
      expect(write).toContain(prefix);
    }

    // The declaration is the one thing inside a writable prefix that a revision
    // must not write. ADR-067 put it beside the bytes, so the rule ADR-007 used
    // to get from `profiles/` sitting outside `data/` is now this negation —
    // anchored to a whole object, never a prefix that would also catch the
    // profile's skills.
    expect(write).toContain('&& !(');
    expect(write).toContain('/objects/profiles/personal/profile.yaml"');

    // The registry and the manifests are read-only for a different reason: the
    // revision reads them and never authors them.
    expect(write).not.toContain('workspaces.yaml');
    expect(write).not.toContain('/objects/providers.d/');
    expect(write).not.toContain('matches(');

    expect(conditions.some((condition) => condition.includes('reads-its-config'))).toBe(true);
  });

  test('a gcs target gets a bucket, the same as an s3 one', async () => {
    // Deployed, every target addresses a bucket: config, state, the log,
    // memory, skills, manifests and attachments are all objects in it.
    const steps = await provision({ adapter: 'gcs', bucket: 'lanes-link-blobs' });
    expect(steps.flatMap((step) => step.argv)).toContain('buckets');
  });

  test('the bucket is created with Autoclass, so cold assets stop costing Standard rates', async () => {
    // The bucket holds the config read on every boot next to assets and audit
    // rows nobody opens again, and it is created once — a class chosen here is
    // the class those objects keep, because nothing revisits an existing bucket.
    const create = (await provision({ adapter: 'gcs', bucket: 'lanes-link-blobs' })).find(
      (step) => step.argv[0] === 'storage' && step.argv[2] === 'create',
    )!;

    expect(create.argv).toContain('--enable-autoclass');
    expect(create.argv[create.argv.indexOf('--autoclass-terminal-storage-class') + 1]).toBe(
      'ARCHIVE',
    );
  });

  test('durability is applied by an update, so it reaches a bucket that already exists', async () => {
    // The create step tolerates failure and is refused as ALREADY_EXISTS from
    // the second deploy onwards, so a protection expressed as a flag on it
    // reaches new buckets only — and every deployment that already exists is
    // exactly the one holding an audit log worth keeping.
    const update = (await provision({ adapter: 'gcs', bucket: 'lanes-link-blobs' })).find(
      (step) => step.argv[0] === 'storage' && step.argv[2] === 'update',
    )!;

    expect(update).toBeDefined();
    expect(update.argv).toContain('gs://lanes-link-blobs');
    // Nothing here is served to a browser, so the useful setting is the one that
    // makes granting anonymous read impossible rather than merely absent.
    expect(update.argv).toContain('--public-access-prevention');
    // The revision holds objectAdmin on data/, which contains objects.delete —
    // so the process most exposed to the internet can erase the record of what
    // it did. Soft delete is what makes that recoverable.
    expect(update.argv[update.argv.indexOf('--soft-delete-duration') + 1]).toBe('30d');
    // And versioning for the other half: an object overwritten in place, where
    // soft delete does not help and the previous content is the thing worth
    // keeping.
    expect(update.argv).toContain('--versioning');
  });

  test('versioning ships with the rule that bounds it', async () => {
    // Unbounded, versioning keeps every prior copy of every state key forever,
    // and state is the one thing here rewritten rather than appended. The rule
    // is a file beside the driver rather than one written at plan time, because
    // `--dry-run` writes nothing.
    const update = (await provision({ adapter: 'gcs', bucket: 'b' })).find(
      (step) => step.argv[0] === 'storage' && step.argv[2] === 'update',
    )!;

    const lifecycle = update.argv[update.argv.indexOf('--lifecycle-file') + 1]!;
    expect(lifecycle.endsWith('src/deployments/gcp/lifecycle.json')).toBe(true);

    const rules = (await Bun.file(lifecycle).json()) as {
      rule: { action: { type: string }; condition: Record<string, number> }[];
    };
    expect(rules.rule.every((entry) => entry.action.type === 'Delete')).toBe(true);
    expect(rules.rule.map((entry) => Object.keys(entry.condition)[0])).toEqual([
      'daysSinceNoncurrentTime',
      'numNewerVersions',
    ]);
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
