import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_FILE, type TargetConfig } from '#profile';
import { workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { provisionProfiles, provisionStepsFor } from './provision-profile.ts';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const PROFILE = (name: string): string =>
  `version: 1\nprofile: ${name}\ninstance: { port: 7337 }\nauth: {}\ngrants: []\nmembers: []\n`;

async function workspace(targets: readonly string[], profile = 'sandbox'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-provision-'));
  roots.push(root);
  await writeFile(join(root, WORKSPACE_FILE), workspaceYaml(targets));
  await writeProfileFixture(root, profile, PROFILE(profile));
  return root;
}

/**
 * Giving a new profile what a running revision needs, without rolling one.
 *
 * The bug behind this: a profile added to a deployed workspace was created,
 * uploaded and never served. A revision reads a credential by reference at
 * request time, so what the new profile lacked was the secret container and the
 * resource-level grant — neither of which is a property of a revision. Secret
 * Manager answers a missing binding with 403 rather than 404 so identities
 * cannot enumerate secrets by error code, the adapter throws on the 403, and
 * `openReconciled` skips a profile it cannot open. From outside that reads
 * exactly like a profile that does not exist.
 *
 * What is asserted here is the half that decides *whether* to act. The steps
 * themselves are the driver's, and the Cloud Run driver reads live IAM policy to
 * plan its removals — so a test that built them would need a project.
 */
describe('provisioning a profile on a target', () => {
  test('a target with no deploy block has nothing to provision', async () => {
    const root = await workspace(['local']);

    // The distinction that keeps this off every `profile add`. A local target
    // has no runtime identity to grant anything to, and its secrets are a file
    // this machine already owns — so there is no cloud call to make, and making
    // one would be the surprise.
    expect(await provisionProfiles({ workspaceRoot: root, target: 'local', profiles: ['sandbox'] }))
      .toEqual({ applicable: false });
  });

  test('the step builder is silent for the same target, so a dry run prints nothing', async () => {
    const root = await workspace(['local']);
    const declared = { credentials: { adapter: 'file' } } as unknown as TargetConfig;

    expect(
      await provisionStepsFor({
        workspaceRoot: root,
        target: 'local',
        declared,
        profiles: ['sandbox'],
      }),
    ).toEqual([]);
  });

  test('a target that cannot be read is reported, not thrown', async () => {
    const root = await workspace(['local']);

    // The contract `profile add` depends on. By the time this runs the profile
    // is already on disk, so a creation that succeeded must not report failure
    // because something outside the repository was unreachable. Every failure
    // path here comes back as a reason.
    const outcome = await provisionProfiles({
      workspaceRoot: root,
      target: 'nowhere',
      profiles: ['sandbox'],
    });

    expect(outcome.applicable).toBe(false);
    expect(outcome.reason).toBeDefined();
  });
});
