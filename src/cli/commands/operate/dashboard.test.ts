import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboard } from './dashboard.ts';

/**
 * `lanes link dashboard` — and the one thing about it that is easy to break.
 *
 * The refusal has to come out *before* the runtime is opened. Opening a runtime
 * opens that target's adapters, so against a deployed target this command
 * reaches a bucket and a secret store first and dies with whatever they say —
 * a storage 403, most usefully — while the sentence explaining that the
 * dashboard is not there sits below, correct and unread.
 *
 * That is not hypothetical: it is what the first version of this command did.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];
const previousTarget = process.env['LANES_LINK_TARGET'];

/**
 * A profile whose `cloud` target points at a project that does not exist.
 *
 * The point of the fixture: if anything opens these adapters, the test fails
 * with a Google error rather than the refusal, which is exactly the regression
 * being guarded against.
 */
const PROFILE = `contract: 1

instance:
  profile: personal
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
`;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-dashboard-'));
  roots.push(root);
  // Set on the process, not merely returned: `resolveWorkspaceRoot` falls back
  // to `~/.lanes-link` when it is absent — the operator's real profiles.
  process.env['LANES_LINK_HOME'] = root;

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'lanes-link.yaml'), 'contract: 1\ndefault_profile: personal\n');
  await writeFile(join(root, 'profiles', 'personal.yaml'), PROFILE);
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  if (previousTarget === undefined) delete process.env['LANES_LINK_TARGET'];
  else process.env['LANES_LINK_TARGET'] = previousTarget;

  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('a deployed target', () => {
  test('is refused, and says why rather than failing at a bucket', async () => {
    await workspace();

    const failure = await dashboard({ profile: 'personal', target: 'cloud' }).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('served only by a local endpoint');
    expect(failure!.message).toContain('ADR-018');
    // What it offers instead, since the question behind the command is still a
    // real one for a deployed target — and it is a paste, so it names both
    // flags rather than leaving one to a fallback that no longer exists
    // (ADR-037).
    expect(failure!.message).toContain(
      'lanes link status --profile personal --target cloud',
    );
  });

  test('names the platform, so the sentence is about this deployment', async () => {
    await workspace();

    const failure = await dashboard({ profile: 'personal', target: 'cloud' }).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure?.message).toContain('cloudrun');
  });
});
