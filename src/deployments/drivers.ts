import { ConfigError, type DeployConfig } from '#profile';
import type { DeployDriver } from './driver.ts';

/**
 * Turning a declared platform into the driver that rolls it out.
 *
 * **This is the only place the mapping exists**, exactly as `target.ts` is the
 * only place an adapter name becomes an open backend. Before this, the mapping
 * was two static imports in the CLI — `#deployments/gcp/deploy.ts` in `main.ts`
 * and `#deployments/gcp/gcloud.ts` in `outputs.ts` — which meant the CLI knew
 * what Cloud Run was and a second host would have had to be threaded through
 * both.
 *
 * The driver is imported *inside* its branch, for the same reason the cloud
 * adapters are: a `lanes link outputs` against a local target must not load a
 * cloud SDK, and a missing cloud credential must not fail a command that was
 * never going to talk to that cloud.
 */
export async function driverFor(platform: DeployConfig['platform']): Promise<DeployDriver> {
  switch (platform) {
    case 'cloudrun': {
      const { cloudRunDriver } = await import('./gcp/driver.ts');
      return cloudRunDriver;
    }
  }

  // Unreachable while `platform` is a closed enum, and kept anyway: the enum
  // and this switch are edited by different hands at different times, and a
  // platform that parses but does not dispatch should say so rather than
  // return undefined into a call chain.
  throw new ConfigError(
    `No deployment driver for platform "${platform as string}". ` +
      'Declare one of: cloudrun.',
  );
}
