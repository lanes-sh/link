import { describe, expect, test } from 'bun:test';
import type { Config } from '#profile';
import { endpointUrl } from './endpoint-url.ts';

/**
 * Which address a command hands to an agent.
 *
 * The failure this guards is silent in the worst way: `mcp add` built the local
 * URL unconditionally, so `--target cloud` registered
 * `http://127.0.0.1:7337/mcp` with the harness. The command reported success,
 * named the right server, and pointed at a port with nothing behind it — and
 * the first symptom was a failed tool call, later, somewhere else.
 */

const config = (target: string, deploy?: object): Config =>
  ({
    instance: { profile: 'personal', host: '127.0.0.1', port: 7337 },
    targets: {
      local: { credentials: { adapter: 'file' }, storage: { adapter: 'filesystem' } },
      ...(deploy
        ? {
            [target]: {
              credentials: { adapter: 'gcp-secret-manager', project: 'p' },
              storage: { adapter: 'gcs', bucket: 'b' },
              deploy,
            },
          }
        : {}),
    },
  }) as unknown as Config;

describe('the endpoint address for a target', () => {
  test('a target with no deployment is the configured host and port', async () => {
    expect(await endpointUrl(config('local'), 'local')).toBe('http://127.0.0.1:7337/mcp');
  });

  test('a deployable target does not fall back to loopback silently', async () => {
    // `url()` asks the platform and returns null when it cannot — gcloud absent,
    // service not deployed yet. Falling back is right; doing it *without having
    // asked* is the bug. Here the driver has no project to ask about, so null is
    // the honest answer and loopback is the honest fallback.
    const declared = { platform: 'cloudrun', region: 'europe-west1', service: 's', access: 'public' };

    expect(await endpointUrl(config('cloud', declared), 'cloud')).toBe('http://127.0.0.1:7337/mcp');
  });

  test('an unknown platform degrades rather than taking the command down', async () => {
    // A platform this binary has no driver for is a config problem `check`
    // reports. `outputs` and `mcp add` must still print something.
    const declared = { platform: 'nowhere', region: 'r', service: 's', access: 'public' };

    expect(await endpointUrl(config('cloud', declared), 'cloud')).toBe('http://127.0.0.1:7337/mcp');
  });
});
