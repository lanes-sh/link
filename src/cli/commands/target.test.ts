import { writeProfileFixture } from '#profile/testing.ts';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTargets, resolvedEntry, targetList, targetUse } from './target.ts';
import type { ResolvedTarget, TargetConfig, WorkspaceTarget } from '#profile';

/**
 * `lanes link target` — what a profile declares, and which one is in play.
 *
 * The property that matters most here is not the table. It is that this command
 * keeps working when `LANES_LINK_TARGET` names something that does not exist:
 * that is the state in which every *other* command has just started refusing,
 * and this is the one somebody runs to find out why.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];
const previousTarget = process.env['LANES_LINK_TARGET'];

const PROFILE = `contract: 3

instance:
  profile: personal
  # A comment nobody asked this command to remove.
  port: 7337

`;

/**
 * The registry, which is where these three used to sit inside the profile.
 *
 * Same three targets, same adapters — declared once by the workspace rather than
 * once per profile (ADR-052). `cloud` deploys and `staging` does not, which is
 * the distinction the listing below is about.
 */
const TARGETS = `contract: 3
default_profile: personal

workspaces:
  local:
    credentials: { adapter: file }
    storage: { adapter: filesystem }
  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    last_deploy: "2026-08-28T09:00:00.000Z"
    last_deploy_version: "0.6.6"
    deploy:
      platform: cloudrun
      project: my-project
      region: europe-west1
      service: my-service
  staging:
    credentials: { adapter: gcp-secret-manager, project: my-other-project }
    storage: { adapter: gcs, bucket: your-other-bucket }
`;

/**
 * A throwaway workspace, and the environment that points at it.
 *
 * Both, deliberately. An injected `env` replaces `process.env` wholesale — so
 * `{ env: {} }` does not mean "no variables set", it means `LANES_LINK_HOME` is
 * gone too, and `resolveWorkspaceRoot` then walks up to `~/.lanes-link`: the
 * operator's real profiles, credentials and audit log. Every call here passes
 * `env` from this helper so that cannot happen.
 */
async function workspace(): Promise<{
  root: string;
  env: Record<string, string | undefined>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-target-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), TARGETS);
  await writeProfileFixture(root, 'personal', PROFILE);
  return { root, env: { LANES_LINK_HOME: root } };
}

beforeEach(() => {
  delete process.env['LANES_LINK_TARGET'];
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;

  // Restored rather than merely deleted: this file is the one place that writes
  // the variable, and leaking it would change what every other test file
  // resolves to — which is the failure it exists to prevent, one level up.
  if (previousTarget === undefined) delete process.env['LANES_LINK_TARGET'];
  else process.env['LANES_LINK_TARGET'] = previousTarget;

  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Everything written to stdout while `body` runs. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }

  return captured;
}

describe('what a profile declares', () => {
  test('reports every target, its adapters, and whether it deploys', async () => {
    const { env } = await workspace();

    const listing = await readTargets({ profile: 'personal' }, { env });

    expect(listing.targets.map((target) => target.name).sort()).toEqual([
      'cloud',
      'local',
      'staging',
    ]);

    const cloud = listing.targets.find((target) => target.name === 'cloud')!;
    expect(cloud.credentials).toBe('gcp-secret-manager');
    expect(cloud.storage).toBe('gcs');
    expect(cloud.deployed).toBe(true);
    expect(cloud.deployment).toMatchObject({ service: 'my-service', region: 'europe-west1' });

    // What rolled it, read off the registry rather than off the endpoint. The
    // image is built from the installed package, so the release that ran the
    // deploy is the code up there — and this answers offline, with the service
    // scaled to zero, from a machine that has never deployed it.
    expect(cloud.lastDeployVersion).toBe('0.6.6');
    expect(cloud.lastDeploy).toBe('2026-08-28T09:00:00.000Z');

    // A target nothing has deployed since the field existed says so rather than
    // implying a version.
    expect(listing.targets.find((target) => target.name === 'staging')!.lastDeployVersion).toBeNull();

    // Declared with no deployment: the distinction `deployed` exists to carry.
    const staging = listing.targets.find((target) => target.name === 'staging')!;
    expect(staging.deployed).toBe(false);
    expect(staging.deployment).toBeNull();
  });

  test('no url key unless somebody asked for one', async () => {
    const { env } = await workspace();

    // Absent means "not asked" and null would mean "asked, no answer". A reader
    // that cannot tell those apart has to shell out to find out.
    const listing = await readTargets({ profile: 'personal' }, { env });
    for (const target of listing.targets) expect('url' in target).toBe(false);
  });

  test('nothing is selected until --workspace names one', async () => {
    // This is the command you run to find out what to pass, so it is the one
    // command that does not require the answer as input. Requiring it would be
    // circular.
    const listing = await readTargets({ profile: 'personal' }, { env: (await workspace()).env });

    expect(listing.selected).toBeNull();
    expect(listing.targets.every((target) => !target.isSelected)).toBe(true);
  });

  test('--workspace marks the one it names', async () => {
    const { env } = await workspace();

    const listing = await readTargets({ profile: 'personal', target: 'cloud' }, { env });

    expect(listing.selected).toBe('cloud');
    expect(listing.targets.find((target) => target.isSelected)?.name).toBe('cloud');
  });

  test('an exported LANES_LINK_TARGET selects nothing', async () => {
    // It used to move the selection without moving the default, and both
    // markers existed to show the disagreement. Nothing reads it now, so there
    // is no disagreement left to show.
    const { root } = await workspace();

    const listing = await readTargets(
      { profile: 'personal' },
      { env: { LANES_LINK_HOME: root, LANES_LINK_TARGET: 'cloud' } },
    );

    expect(listing.selected).toBeNull();
  });
});

describe('a pointer, which is what a deployed target looks like from here', () => {
  test('carries the deploy record, so the version is readable with the bucket offline', async () => {
    // The one part of a pointer entry that is not somewhere else. `list`
    // deliberately follows no pointer — that is a network read per entry — so if
    // the record were only in the bucket, the question "which release is up
    // there" would need the bucket to answer it, on the command that exists to
    // work when the bucket does not.
    const { root, env } = await workspace();
    await writeFile(
      join(root, 'workspaces.yaml'),
      `contract: 3

workspaces:
  cloud:
    at: gs://your-bucket
    primary: personal
    last_deploy: "2026-08-28T09:00:00.000Z"
    last_deploy_version: "0.6.6"
`,
    );

    const cloud = (await readTargets({ profile: 'personal' }, { env })).targets[0]!;

    expect(cloud.pointsAt).toBe('gs://your-bucket');
    expect(cloud.lastDeployVersion).toBe('0.6.6');
  });
});

/**
 * `show` is the command that follows the pointer, so what it reports is what is
 * on the other end of it.
 *
 * `openTarget` merges the local pointer over the remote declaration — so a
 * redeploy from a second machine does not lose the first one's record of who
 * opens the endpoint — and the merged entry therefore carries `at:`
 * beside the adapters. `isPointer` answers yes to anything with an `at:`.
 * The result was that `target show cloud` reported no adapters, no deployment,
 * and "this target runs wherever the CLI does" about a target with a live Cloud
 * Run service in front of it, and the deploy record it is now asked to print
 * would have gone the same way.
 */
describe('showing a target this workspace only points at', () => {
  const declared = {
    credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
    storage: { adapter: 'gcs', bucket: 'your-bucket' },
    vault: { adapter: 'secret' },
    deploy: {
      platform: 'cloudrun',
      project: 'my-project',
      region: 'europe-west1',
      service: 'my-service',
    },
  } as TargetConfig;

  /** What `openTarget` hands back for a remote target: pointer over declaration. */
  const resolved = {
    target: 'cloud',
    workspaceRoot: 'gs://your-bucket',
    declared,
    entry: {
      at: 'gs://your-bucket',
      ...declared,
      primary: 'personal',
      last_deploy: '2026-08-28T09:00:00.000Z',
      last_deploy_version: '0.6.7',
    } as WorkspaceTarget,
    remote: true,
  } as ResolvedTarget;

  test('the adapters and the deployment come through, rather than reading as a pointer', () => {
    const entry = resolvedEntry(resolved);

    expect(entry.at).toBeUndefined();
    expect(entry.storage?.bucket).toBe('your-bucket');
    expect(entry.deploy?.service).toBe('my-service');
  });

  test('and so does the deploy record, which is the reason to run it', () => {
    expect(resolvedEntry(resolved).last_deploy_version).toBe('0.6.7');
    expect(resolvedEntry(resolved).primary).toBe('personal');
  });
});

describe('when --workspace names a target that does not exist', () => {
  test('the listing survives and says so', async () => {
    // The state in which every other command is refusing, and this is the
    // command someone runs to find out why — so it must not fail the same way.
    const { env } = await workspace();

    const listing = await readTargets({ profile: 'personal', target: 'clod' }, { env });

    expect(listing.selectedDeclared).toBe(false);
    expect(listing.targets.map((target) => target.name).sort()).toEqual([
      'cloud',
      'local',
      'staging',
    ]);
  });

  test('and the printed output warns rather than throwing', async () => {
    const { env } = await workspace();

    const printed = await captureStdout(async () => {
      await targetList({ profile: 'personal', target: 'clod', ...({ env } as object) });
    });

    expect(printed).toContain('clod');
  });
});

describe('target list --json', () => {
  test('puts nothing but JSON on stdout', async () => {
    await workspace();

    const written = await captureStdout(() => targetList({ profile: 'personal', json: true }));

    // The assertion is the parse: the profile line every command prints would
    // throw here and nowhere else.
    const parsed = JSON.parse(written) as { selected: string | null; targets: { name: string }[] };
    expect(parsed.selected).toBeNull();
    expect(parsed.targets.map((target) => target.name).sort()).toEqual([
      'cloud',
      'local',
      'staging',
    ]);
  });
});

describe('target use, after it was removed', () => {
  test('refuses in its own words rather than as an unknown command', async () => {
    // A command that writes a key nothing reads reports success and changes
    // nothing observable — the exact failure this change removes. Deleting it
    // outright would send someone hunting a typo in a command they have run for
    // months, so it says what happened instead.
    expect(() => targetUse('cloud')).toThrow('was removed');
    expect(() => targetUse('cloud')).toThrow('instance.default_target');
    expect(() => targetUse('cloud')).toThrow('--workspace cloud');
  });
});
