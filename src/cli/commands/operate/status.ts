import { listProfiles } from '#profile';
import { oneProfile, visibleCapabilities } from '#server/mcp';
import { toPolicyDocument } from '#registry';
import { announce, emit, heading, print, style, table } from '../../output.ts';
import { openRuntime, ownerPrincipal, type GlobalFlags } from '../../runtime.ts';

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

    const endpoint = `http://${runtime.config.instance.host}:${runtime.config.instance.port}/mcp`;

    return emit(
      flags.json,
      {
        profile: runtime.resolution.profile,
        profiles: await listProfiles(runtime.resolution.workspaceRoot),
        target: runtime.target,
        endpoint,
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
        print(`  ${endpoint}  ${style.dim('(when running)')}`);
      },
    );
  } finally {
    await runtime.close();
  }
}
