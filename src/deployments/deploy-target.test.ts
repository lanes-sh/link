import { describe, expect, test } from 'bun:test';
import { resolveDeployTarget } from './deploy-target.ts';

/**
 * What a deployment gets called.
 *
 * `cloud` was the docs' example, and it is what everybody ended up typing every
 * day. It says where the thing is, not what it is — and once there are two, the
 * flag stops telling you which one you are about to redeploy.
 */

const flags = (target?: string) => ({ target }) as Parameters<typeof resolveDeployTarget>[0];

describe('naming a deployment', () => {
  test('an explicit --workspace always wins', async () => {
    // The whole difference from the inference ADR-037 removed: this never
    // overrides something somebody typed.
    expect(await resolveDeployTarget(flags('my-own-name'), async () => 'acme-prod')).toBe(
      'my-own-name',
    );
  });

  test('omitted, it says what the thing is', async () => {
    expect(await resolveDeployTarget(flags(), async () => 'acme-prod')).toBe(
      'self-hosted-acme-prod',
    );
  });

  test('with no project to derive from, it asks rather than inventing', async () => {
    // A generic fallback name would be the worst of both: nobody chose it, and
    // it says nothing. Better to stop and name the two ways forward.
    await expect(resolveDeployTarget(flags(), async () => null)).rejects.toThrow(
      /--workspace|gcloud config set project/,
    );
  });

  test('the refusal names both ways out', async () => {
    const failure = await resolveDeployTarget(flags(), async () => null).catch(
      (error: Error) => error.message,
    );

    expect(failure).toContain('--workspace');
    expect(failure).toContain('gcloud config set project');
  });
});
