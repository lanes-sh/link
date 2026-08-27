import { listProfiles, loadWorkspaceProfiles, resolveWorkspaceRoot } from '#profile';
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
  if (flags.profile === undefined) return workspaceStatus(flags);

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
        // Null rather than absent: a caller reading this to prefill a rename box
        // needs to tell "called nothing in particular" from a field it forgot.
        label: connection.label ?? null,
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
              // Both, where they differ. The label is what the operator called
              // it and the account is which mailbox it is; a row answering only
              // one of those is the row this column already was.
              style.dim(
                connection.label && connection.label !== connection.account
                  ? `${connection.label} — ${connection.account}`
                  : connection.account,
              ),
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

/**
 * `lanes link status --target <t>` — the whole workspace at one target.
 *
 * The default, because the subject of this command is the endpoint and one
 * endpoint serves every profile in the workspace (ADR-009, ADR-043). Naming a
 * profile narrows it to the detailed view above; naming none is not a missing
 * answer, it is the wider one.
 *
 * **Opens no store and makes no network call.** The view above already declines
 * to probe, for the reasons in this file's header; this one additionally
 * declines to open a target's adapters, so it stays instant and — more to the
 * point — still answers for a target whose stores are unreachable, misdeclared,
 * or gone. A summary that needs the deployment to be healthy cannot report that
 * it is not.
 *
 * That is what makes the row it exists for legible: a target declared by one
 * profile and not its sibling. From inside either profile that state is
 * invisible, and it is what a vanished deployment looks like from the outside.
 */
async function workspaceStatus(flags: StatusFlags): Promise<void> {
  const target = flags.target!;
  const root = resolveWorkspaceRoot();
  const workspace = await loadWorkspaceProfiles(root);

  const profiles = workspace.loaded.map((entry) => ({
    name: entry.profile,
    declares: target in entry.config.targets,
    connections: entry.config.connections.length,
    deployment: deploymentIdentity(entry.config.targets[target]?.deploy),
  }));

  const declaring = profiles.filter((entry) => entry.declares);

  // Distinct deployments, not the first one found. Two profiles declaring the
  // same target name against different services is drift worth printing rather
  // than a tie to break silently — and picking one would make the wrong half of
  // the workspace look correctly configured.
  const deployments = [
    ...new Map(
      declaring
        .filter((entry) => entry.deployment !== null)
        .map((entry) => [JSON.stringify(entry.deployment), entry.deployment!] as const),
    ).values(),
  ];

  return emit(
    flags.json,
    { workspace: root, target, profiles, deployments, unreadable: workspace.unreadable },
    () => {
      print(style.dim(`workspace ${style.bold(root)}  target ${style.bold(target)}`));

      heading('Profiles');
      table(
        profiles.map((entry) => [
          `  ${style.bold(entry.name)}`,
          entry.declares ? style.green(`${target} declared`) : style.yellow('not declared'),
          style.dim(entry.declares ? `${entry.connections} connection(s)` : '—'),
        ]),
      );
      for (const bad of workspace.unreadable) {
        print(`  ${style.bold(bad.profile)}  ${style.yellow(bad.reason)}`);
      }

      heading('Endpoint');
      if (declaring.length === 0) {
        print(style.yellow(`  No profile declares "${target}".`));
        print(
          style.dim(
            '  If it was deployed once, the deployment still exists and only the\n' +
              `  declaration is gone — recover it with: lanes link sync targets --target ${target}`,
          ),
        );
        return;
      }

      if (deployments.length === 0) {
        print(style.dim('  No deployment — this target runs wherever the CLI does.'));
        return;
      }

      for (const deployment of deployments) {
        const { platform, service, region } = deployment;
        print(`  ${platform} service ${style.bold(service)} in ${region}`);
      }

      if (deployments.length > 1) {
        print(
          style.yellow(
            `  ${deployments.length} profiles declare "${target}" against different services.`,
          ),
        );
        print(style.dim('  They are separate endpoints sharing a name. Check each profile.'));
        return;
      }

      print(
        style.dim(
          "  the address is the platform's to assign — run: " +
            `lanes link outputs --target ${target} --profile ${declaring[0]!.name}`,
        ),
      );
    },
  );
}
