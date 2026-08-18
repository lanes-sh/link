import type { Config, DeployConfig } from '#profile';

/**
 * Where this profile's endpoint answers, for the target in play.
 *
 * Deployed, it is not derivable: Cloud Run mixes a project hash into the
 * hostname, so the URL has to be asked for and asking is the driver's job.
 * Locally it is host and port from the config.
 *
 * Shared because getting it wrong is silent in the worst way. `outputs` asked
 * the driver; `mcp add` built the local URL unconditionally, so
 * `lanes link mcp add --target cloud` registered `http://127.0.0.1:7337/mcp`
 * with the agent — a registration that looks successful, names the right
 * server, and points at a port with nothing behind it. One of the two had the
 * answer and the other could not see it, which is what a copied line does
 * eventually.
 */
export async function endpointUrl(config: Config, target: string): Promise<string> {
  const deployed = await deployedUrl(config.targets[target]?.deploy);
  return deployed ?? `http://${config.instance.host}:${config.instance.port}/mcp`;
}

/**
 * The URL the platform assigned this target's service, if it has one.
 *
 * Degrades to null rather than failing: the platform's CLI may be absent, the
 * service may not be deployed yet, and neither is a reason for a command that
 * only wanted to print an address to stop working. A target with no deployment
 * block never reaches the driver at all.
 */
export async function deployedUrl(declared: DeployConfig | undefined): Promise<string | null> {
  if (!declared) return null;

  try {
    const { driverFor } = await import('#deployments/drivers.ts');
    const url = await (await driverFor(declared.platform)).url(declared);
    return url ? `${url}/mcp` : null;
  } catch {
    // A platform this binary has no driver for is a config problem `check`
    // reports; it must not take the caller down with it.
    return null;
  }
}
