import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTargets, targetList, targetUse } from './target.ts';

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

const PROFILE = `contract: 1

instance:
  profile: personal
  # A comment nobody asked this command to remove.
  default_target: local
  port: 7337

targets:
  local:
    credentials: { adapter: file }
    storage: { adapter: filesystem }
  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
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
  await writeFile(join(root, 'lanes-link.yaml'), 'contract: 1\ndefault_profile: personal\n');
  await writeFile(join(root, 'profiles', 'personal.yaml'), PROFILE);
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

    const listing = await readTargets({}, { env });

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

    // Declared with no deployment: the distinction `deployed` exists to carry.
    const staging = listing.targets.find((target) => target.name === 'staging')!;
    expect(staging.deployed).toBe(false);
    expect(staging.deployment).toBeNull();
  });

  test('no url key unless somebody asked for one', async () => {
    const { env } = await workspace();

    // Absent means "not asked" and null would mean "asked, no answer". A reader
    // that cannot tell those apart has to shell out to find out.
    const listing = await readTargets({}, { env });
    for (const target of listing.targets) expect('url' in target).toBe(false);
  });

  test('the default and the selection are the same until something separates them', async () => {
    const { env } = await workspace();

    const listing = await readTargets({}, { env });

    expect(listing.default).toBe('local');
    expect(listing.selected).toBe('local');
    expect(listing.selectedSource).toBe('config-default');
    expect(listing.selectedDeclared).toBe(true);
  });

  test('LANES_LINK_TARGET moves the selection without moving the default', async () => {
    const { root } = await workspace();

    const listing = await readTargets(
      {},
      { env: { LANES_LINK_HOME: root, LANES_LINK_TARGET: 'cloud' } },
    );

    expect(listing.default).toBe('local');
    expect(listing.selected).toBe('cloud');
    expect(listing.selectedSource).toBe('environment');
    expect(listing.targets.find((target) => target.name === 'local')!.isDefault).toBe(true);
    expect(listing.targets.find((target) => target.name === 'cloud')!.isSelected).toBe(true);
  });

  test('--target beats the environment', async () => {
    const { root } = await workspace();

    const listing = await readTargets(
      { target: 'staging' },
      { env: { LANES_LINK_HOME: root, LANES_LINK_TARGET: 'cloud' } },
    );

    expect(listing.selected).toBe('staging');
    expect(listing.selectedSource).toBe('flag');
  });
});

describe('when the environment names a target that does not exist', () => {
  test('the listing survives and says so', async () => {
    const { root } = await workspace();

    // Every other command is refusing by now. This one has to answer, because
    // it is the one that shows the name is wrong and what it was measured
    // against — going through `resolveProfile` here would throw instead.
    const listing = await readTargets(
      {},
      { env: { LANES_LINK_HOME: root, LANES_LINK_TARGET: 'clod' } },
    );

    expect(listing.selected).toBe('clod');
    expect(listing.selectedDeclared).toBe(false);
    expect(listing.targets).toHaveLength(3);
  });

  test('and the printed output names the variable', async () => {
    await workspace();
    process.env['LANES_LINK_TARGET'] = 'clod';

    const written = await captureStdout(() => targetList({}));

    expect(written).toContain('LANES_LINK_TARGET');
    expect(written).toContain('clod');
  });
});

describe('target list --json', () => {
  test('puts nothing but JSON on stdout', async () => {
    await workspace();

    const written = await captureStdout(() => targetList({ json: true }));

    // The assertion is the parse: the resolution line every command prints
    // would throw here and nowhere else.
    const parsed = JSON.parse(written) as { default: string; targets: { name: string }[] };
    expect(parsed.default).toBe('local');
    expect(parsed.targets.map((target) => target.name).sort()).toEqual([
      'cloud',
      'local',
      'staging',
    ]);
  });
});

describe('target use', () => {
  test('rewrites default_target and leaves the comments alone', async () => {
    const { root, env } = await workspace();

    await captureStdout(() => targetUse('cloud', {}));

    const written = await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8');
    expect(written).toContain('default_target: cloud');
    expect(written).toContain('# A comment nobody asked this command to remove.');

    expect((await readTargets({}, { env })).default).toBe('cloud');
  });

  test('refuses a target that is not declared, and lists what is', async () => {
    await workspace();

    await expect(captureStdout(() => targetUse('clod', {}))).rejects.toThrow(
      /Target "clod" is not declared.*local, cloud, staging/s,
    );
  });

  test('writing the value it already holds does not touch the file', async () => {
    const { root } = await workspace();
    const path = join(root, 'profiles', 'personal.yaml');
    const before = await readFile(path, 'utf8');

    await captureStdout(() => targetUse('local', {}));

    // A no-op rewrite churns mtime for nothing, and on a bucket workspace it
    // costs a PUT.
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('says when the environment will keep winning anyway', async () => {
    await workspace();
    process.env['LANES_LINK_TARGET'] = 'staging';

    const written = await captureStdout(() => targetUse('cloud', {}));

    // Otherwise the operator edits the file, sees nothing change, and concludes
    // the command is broken.
    expect(written).toContain('default target is now');
    expect(written).toMatch(/LANES_LINK_TARGET=staging.*still wins/);
  });
});
