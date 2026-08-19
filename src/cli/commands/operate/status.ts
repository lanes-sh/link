import { listProfiles } from '#profile';
import { oneProfile, visibleCapabilities } from '#server/mcp';
import { toPolicyDocument } from '#registry';
import { announce, emit, heading, print, style, table } from '../../output.ts';
import { openRuntime, ownerPrincipal, type GlobalFlags } from '../../runtime.ts';
import { deploymentIdentity } from '../../endpoint-url.ts';

/** `lanes link status` — connections, what is reachable through them, and where. */

export interface StatusFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
}

/**
 * Deliberately no `running` field, unlike `outputs`.
 *
 * `status` answers from config, the database, and policy — no network call. A
 * health probe would make the command that tells you what is configured depend
 * on something being up, and `outputs --json` already reports liveness.
 *
 * Which is why a deployed target prints its *identity* rather than its address.
 * This used to print `http://<host>:<port>/mcp` unconditionally, so
 * `status --target cloud` named a loopback port with nothing behind it — the
 * bug `endpoint-url.ts` records having already fixed in `mcp add`. Reaching for
 * `endpointUrl` here would fix the lie by surrendering the property above: it
 * shells out to `gcloud`, costs seconds, needs the CLI installed and
 * authenticated, and swallows every failure back into loopback — so on a fresh
 * machine or in CI it would print the same wrong answer, more slowly.
 *
 * A deployment's address is the platform's to assign and `outputs --target` is
 * the command that asks. Which service it is, though, is in the config, and a
 * config-only command can say that much honestly.
 */
export async function status(flags: StatusFlags): Promise<void> {
  const runtime = await openRuntime(flags);
  try {
    const records = await runtime.state.connections.list();
    const byKey = new Map(records.map((record) => [`${record.provider}.${record.id}`, record]));

    const connections = runtime.config.connections.map((connection) => {
      const key = `${connection.provider}.${connection.id}`;
      return {
        key,
        provider: connection.provider,
        id: connection.id,
        account: connection.account,
        state: byKey.get(key)?.status ?? 'not reconciled',
      };
    });

    const capabilities = visibleCapabilities({
      profiles: oneProfile(runtime.resolution.profile, {
        config: runtime.config,
        registry: runtime.registry,
        dispatcher: runtime.dispatcher,
        policy: toPolicyDocument(runtime.config),
      }),
      principal: ownerPrincipal(runtime.config.instance.profile),
    });

    // What is registered but has no connection yet — the other half of "what is
    // set up", and the half an agent needs to answer "what else could I use?".
    const connected = new Set(connections.map((connection) => connection.provider));
    const notConnected = runtime.registry
      .list()
      .map((entry) => entry.manifest.id)
      .filter((id) => !connected.has(id))
      .sort();

    // Null rather than a different shape: `endpoint` stays a string-or-null so a
    // consumer that reads it keeps working, and `deployment` carries what
    // replaces it. Silently turning a string into an object would be a cost
    // paid by every reader for the benefit of none.
    const local = `http://${runtime.config.instance.host}:${runtime.config.instance.port}/mcp`;
    const deployment = deploymentIdentity(runtime.config.targets[runtime.target]?.deploy);
    const endpoint = deployment ? null : local;

    return emit(
      flags.json,
      {
        profile: runtime.resolution.profile,
        profiles: await listProfiles(runtime.resolution.workspaceRoot),
        target: runtime.target,
        endpoint,
        deployment,
        connections,
        capabilities,
        notConnected,
      },
      () => {
        announce(runtime.resolution);

        heading('Connections');
        if (connections.length === 0) {
          print(style.dim('  none — run: lanes link connect example'));
        } else {
          table(
            connections.map((connection) => [
              `  ${style.bold(connection.key)}`,
              connection.state === 'active'
                ? style.green(connection.state)
                : style.yellow(connection.state),
              style.dim(connection.account),
            ]),
          );
        }

        heading('Reachable capabilities');
        if (capabilities.length === 0) {
          print(style.dim('  none — default deny is in effect and nothing is granted'));
        } else {
          for (const capability of capabilities) print(`  ${capability}`);
        }

        heading('Endpoint');
        if (!deployment) {
          print(`  ${local}  ${style.dim('(when running)')}`);
        } else {
          const { platform, service, region } = deployment;
          print(`  ${platform} service ${style.bold(service)} in ${region}`);
          print(
            style.dim(
              '  the address is the platform\'s to assign — run: ' +
                `lanes link outputs --target ${runtime.target}`,
            ),
          );
        }
      },
    );
  } finally {
    await runtime.close();
  }
}
