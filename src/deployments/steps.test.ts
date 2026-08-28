import { describe, expect, test } from 'bun:test';
import type { CommandResult, DeployDriver, DeployStep } from './driver.ts';
import { expectedOutcome, isAlreadyGone, isAlreadyThere, isUnready, runSteps } from './steps.ts';

/**
 * Waiting out an API that was enabled a moment ago.
 *
 * Enabling one returns before it is usable, and inside that gap Google answers
 * with a permission error rather than a "still starting" one — so the message is
 * indistinguishable from holding the wrong role on a project you own. This
 * command enables seven APIs and immediately uses all of them. A real deploy
 * failed here, at the build, after uploading its source.
 */
describe('a step whose API has not propagated yet', () => {
  const step: DeployStep = { title: 'build and push the image', argv: ['builds', 'submit'] };

  /** Fails with `stderr` for the first `failures` calls, then succeeds. */
  function driverFailing(failures: number, stderr: string): DeployDriver & { calls: number } {
    const driver = {
      calls: 0,
      platform: 'cloudrun' as const,
      tool: 'gcloud',
      preflight: () => null,
      survey: () => Promise.reject(new Error('not used')),
      provision: () => Promise.resolve([]),
      plan: () => [],
      url: () => Promise.resolve(null),
      run(): Promise<CommandResult> {
        driver.calls += 1;
        return Promise.resolve(
          driver.calls <= failures
            ? { ok: false, stdout: '', stderr }
            : { ok: true, stdout: '', stderr: '' },
        );
      },
    };
    return driver as DeployDriver & { calls: number };
  }

  // Verbatim, from the deploy that failed.
  const DENIED =
    'ERROR: (gcloud.builds.submit) PERMISSION_DENIED: The caller does not have permission';

  test('is retried until it works', async () => {
    const driver = driverFailing(2, DENIED);
    await runSteps(driver, [step], [0, 0, 0]);

    expect(driver.calls).toBe(3);
  });

  test('gives up rather than retrying forever, and reports the real message', async () => {
    const driver = driverFailing(99, DENIED);
    await expect(runSteps(driver, [step], [0, 0])).rejects.toThrow(/PERMISSION_DENIED/);

    // The initial attempt plus the two the backoff allows, and no more.
    expect(driver.calls).toBe(3);
  });

  test('a failure that is not about readiness is not retried', async () => {
    // Retrying a step that already exists, or a build whose Dockerfile is
    // broken, spends the budget to arrive at the same answer more slowly.
    const driver = driverFailing(99, 'ALREADY_EXISTS: the repository already exists');
    await expect(runSteps(driver, [step], [0, 0, 0])).rejects.toThrow(/ALREADY_EXISTS/);

    expect(driver.calls).toBe(1);
  });

  test('a tolerated step that succeeds on retry is not reported as failed', async () => {
    const driver = driverFailing(1, DENIED);
    await runSteps(driver, [{ ...step, tolerateFailure: true }], [0]);

    expect(driver.calls).toBe(2);
  });
});

describe('a step that has already happened', () => {
  test('the shapes Google uses to say so', () => {
    // Every provisioning step is written to be run again, and on a second
    // deploy all of them are. Letting these through as errors meant a
    // successful deploy printed a screen of red for the expected case, which
    // teaches an operator to skim past the output that matters when something
    // is actually wrong.
    for (const message of [
      'ERROR: (gcloud.iam.service-accounts.create) Resource in projects [p] is the subject of a conflict: Service account already exists within project',
      'ERROR: (gcloud.secrets.create) Resource in projects [p] is the subject of a conflict: Secret [x] already exists.',
      'ERROR: (gcloud.storage.buckets.create) HTTPError 409: Your previous request to create the named bucket succeeded and you already own it.',
      'ERROR: (gcloud.artifacts.repositories.create) ALREADY_EXISTS: the repository already exists',
    ]) {
      expect(isAlreadyThere(message)).toBe(true);
    }
  });

  test('and not a failure that leaves something missing', () => {
    // A tolerated failure that is not "already there" is how a deploy rolls a
    // revision with no service account and finds out minutes later.
    for (const message of [
      'PERMISSION_DENIED: The caller does not have permission',
      'INVALID_ARGUMENT: service name must match',
      '',
    ]) {
      expect(isAlreadyThere(message)).toBe(false);
    }
  });
});

describe('a step that takes something away', () => {
  const removal: DeployStep = {
    title: 'drop the superseded binding',
    argv: ['storage', 'buckets', 'remove-iam-policy-binding'],
    tolerateFailure: true,
    removes: true,
  };

  test('the shapes gcloud uses to say there was nothing there', () => {
    // The second deploy after the one that removed it finds nothing to remove,
    // exactly as the second deploy after a create finds the thing present.
    for (const message of [
      'ERROR: (gcloud.projects.remove-iam-policy-binding) Policy binding with the specified principal and role not found!',
      'ERROR: (gcloud.secrets.get-iam-policy) NOT_FOUND: Secret [x] not found.',
      'ERROR: (gcloud.storage.buckets.remove-iam-policy-binding) HTTPError 404: The specified bucket does not exist.',
    ]) {
      expect(isAlreadyGone(message)).toBe(true);
      expect(expectedOutcome(removal, message)).toBe('already gone');
    }
  });

  test('and a step that was adding something reads NOT_FOUND as the failure it is', () => {
    // The distinction is what the step *does*, not the message. A binding step
    // answered NOT_FOUND means the secret it was binding is not there — which is
    // a deploy rolling a revision that cannot read its own token, and it has to
    // stay visible.
    const binding: DeployStep = {
      title: 'let the revision read profile/token',
      argv: ['secrets', 'add-iam-policy-binding'],
      tolerateFailure: true,
    };

    expect(expectedOutcome(binding, 'NOT_FOUND: Secret [profile__token] not found.')).toBeNull();
    expect(expectedOutcome(removal, 'PERMISSION_DENIED: The caller does not have permission')).toBeNull();
  });
});

describe('which failures are worth waiting out', () => {
  test('the shapes Google uses for an API that is not ready', () => {
    for (const message of [
      'PERMISSION_DENIED: The caller does not have permission',
      'Cloud Build API has not been used in project personal-lanes before or it is disabled',
      'SERVICE_DISABLED',
      'Error 403: Cloud Run Admin API is not enabled',
    ]) {
      expect(isUnready(message)).toBe(true);
    }
  });

  test('and not an answer that will not change', () => {
    for (const message of [
      'ALREADY_EXISTS: Repository already exists',
      'INVALID_ARGUMENT: service name must match',
      'failed to build: COPY failed: no source files were specified',
      '',
    ]) {
      expect(isUnready(message)).toBe(false);
    }
  });
});
