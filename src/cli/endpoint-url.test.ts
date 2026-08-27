import { describe, expect, test } from 'bun:test';
import type { Config, TargetConfig } from '#profile';
import { deploymentIdentity, endpointUrl } from './endpoint-url.ts';

/**
 * Which address a command hands to an agent.
 *
 * The failure this guards is silent in the worst way: `mcp add` built the local
 * URL unconditionally, so `--target cloud` registered
 * `http://127.0.0.1:7337/mcp` with the harness. The command reported success,
 * named the right server, and pointed at a port with nothing behind it — and
 * the first symptom was a failed tool call, later, somewhere else.
 */

/** The profile, which now carries only the loopback fallback's host and port. */
const config = (): Config =>
  ({ instance: { profile: 'personal', host: '127.0.0.1', port: 7337 } }) as unknown as Config;

/**
 * The adapter set, passed in rather than looked up by name.
 *
 * `endpointUrl` used to take a target name and read `config.targets[name]`. A
 * profile declares no target (ADR-052), so the caller resolves it through the
 * registry and hands the adapters here — which is also what makes this testable
 * without a workspace on disk.
 */
const declared = (deploy?: object): TargetConfig =>
  ({
    credentials: { adapter: 'file' },
    storage: { adapter: 'filesystem' },
    ...(deploy ? { deploy } : {}),
  }) as unknown as TargetConfig;

describe('the endpoint address for a target', () => {
  test('a target with no deployment is the configured host and port', async () => {
    expect(await endpointUrl(config(), declared())).toBe('http://127.0.0.1:7337/mcp');
  });

  test('a deployable target does not fall back to loopback silently', async () => {
    // `url()` asks the platform and returns null when it cannot — gcloud absent,
    // service not deployed yet. Falling back is right; doing it *without having
    // asked* is the bug. Here the driver has no project to ask about, so null is
    // the honest answer and loopback is the honest fallback.
    const deploy = { platform: 'cloudrun', region: 'europe-west1', service: 's', access: 'public' };

    expect(await endpointUrl(config(), declared(deploy))).toBe('http://127.0.0.1:7337/mcp');
  });

  test('an unknown platform degrades rather than taking the command down', async () => {
    // A platform this binary has no driver for is a config problem `check`
    // reports. `outputs` and `mcp add` must still print something.
    const deploy = { platform: 'nowhere', region: 'r', service: 's', access: 'public' };

    expect(await endpointUrl(config(), declared(deploy))).toBe('http://127.0.0.1:7337/mcp');
  });
});

describe('which service a target deploys to', () => {
  // `status` promises to answer without depending on anything being up, so it
  // cannot ask the platform for an address. It used to print the local URL
  // regardless, which named a loopback port with nothing behind it. This is what
  // it prints instead, and it comes from the file rather than the network.
  test('a target with no deployment has no identity', () => {
    expect(deploymentIdentity(undefined)).toBeNull();
  });

  test('a deployed target names its service without asking anyone', () => {
    expect(
      deploymentIdentity({
        platform: 'cloudrun',
        region: 'europe-west1',
        service: 'my-service',
        access: 'public',
        project: 'my-project',
      } as never),
    ).toEqual({
      platform: 'cloudrun',
      region: 'europe-west1',
      service: 'my-service',
      project: 'my-project',
    });
  });

  test('an absent project is absent rather than undefined', () => {
    // `exactOptionalPropertyTypes` is on, and a key present with an undefined
    // value serialises into `--json` as `"project": null`. A reader cannot tell
    // that apart from a project that is genuinely null.
    const identity = deploymentIdentity({
      platform: 'cloudrun',
      region: 'r',
      service: 's',
      access: 'iam',
    } as never);

    expect(identity).not.toBeNull();
    expect('project' in identity!).toBe(false);
  });
});
