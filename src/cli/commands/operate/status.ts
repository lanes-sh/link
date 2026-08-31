import { wasDefaulted } from '../../selection-require.ts';
import {
  isPointer,
  listProfiles,
  loadWorkspaceProfiles,
  notInRegistry,
  openTarget,
  readRegistry,
  resolveWorkspaceRoot,
  type ResolvedTarget,
} from '#profile';
import { oneProfile, visibleCapabilities } from '#server/mcp';
import { toPolicyDocument } from '#registry';
import { announce, emit, heading, print, style, table } from '../../output.ts';
import { grantedConnections, openRuntime, ownerPrincipal, type GlobalFlags } from '../../runtime.ts';
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
 * `status --workspace cloud` named a loopback port with nothing behind it — the
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

    const connections = grantedConnections(runtime).map((connection) => {
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
    const deployment = deploymentIdentity(runtime.declared.deploy);
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
 * **Opens no profile store.** The view above already declines to probe, for the
 * reasons in this file's header; this one additionally declines to open a
 * target's adapters, so it stays fast and — more to the point — still answers
 * for a target whose stores are unreachable or gone. A summary that needs the
 * deployment to be healthy cannot report that it is not.
 *
 * It does read the target's workspace, which for a pointer is a bucket. That is
 * the one call it cannot avoid: the profiles it is reporting on live there
 * (ADR-052). When that read fails it says so under the target's own heading
 * rather than printing an empty profile list, because "no profiles" and "could
 * not look" are the two answers this command must never blur.
 *
 * The row it used to exist for — a target declared by one profile and not its
 * sibling — cannot happen now. A target is declared once, by its workspace, so
 * there is no per-profile disagreement left to surface.
 */
async function workspaceStatus(flags: StatusFlags): Promise<void> {
  const target = flags.target!;
  const localRoot = resolveWorkspaceRoot();
  const registry = await readRegistry(localRoot);
  const entry = registry[target];

  if (!entry) throw notInRegistry(target, registry, localRoot);

  let resolved: ResolvedTarget | undefined;
  let unreachable: string | undefined;
  try {
    resolved = await openTarget(localRoot, target);
  } catch (error) {
    // The whole message, not its first line. Truncating to `split('\n')[0]` is
    // exactly what the sync command used to do, and it is why a bucket refusing
    // for a nameable reason reported an empty one instead — a `ConfigError`
    // carries its fix on the lines after the first.
    unreachable = error instanceof Error ? error.message : String(error);
  }

  const root = resolved?.workspaceRoot ?? (isPointer(entry) ? entry.at : localRoot);
  const workspace = resolved ? await loadWorkspaceProfiles(root) : undefined;

  const profiles = (workspace?.loaded ?? []).map((loaded) => ({
    name: loaded.profile,
    grants: loaded.config.grants.length,
  }));

  const deployment = deploymentIdentity(resolved?.declared.deploy);

  return emit(
    flags.json,
    {
      workspace: root,
      target,
      remote: resolved?.remote ?? isPointer(entry),
      reachable: unreachable === undefined,
      ...(unreachable ? { error: unreachable } : {}),
      profiles,
      deployment,
      unreadable: workspace?.unreadable ?? [],
    },
    () => {
      // The same shape `announce` prints, including whether the workspace was
      // typed or defaulted — a command that reported it differently would make
      // ADR-061's echo a thing an operator has to learn twice.
      print(
        style.dim(
          `workspace ${style.bold(target)}${wasDefaulted(target) ? ' (default)' : ''}  ${root}`,
        ),
      );

      if (unreachable !== undefined) {
        heading('Unreachable');
        // The refusal's own wording, and nothing after it. A generic trailer
        // here read as a second, vaguer diagnosis of a problem the message above
        // had already named precisely.
        for (const line of unreachable.split('\n')) print(`  ${style.yellow(line)}`);
        return;
      }

      heading('Profiles');
      if (profiles.length === 0) {
        print(style.dim('  None yet.'));
        print(style.dim(`  Create one with: lanes link profile add <name> --workspace ${target}`));
      } else {
        table(
          profiles.map((profile) => [
            `  ${style.bold(profile.name)}`,
            style.dim(`${profile.grants} grant(s)`),
          ]),
        );
      }
      for (const bad of workspace?.unreadable ?? []) {
        print(`  ${style.bold(bad.profile)}  ${style.yellow(bad.reason)}`);
      }

      heading('Endpoint');
      if (!deployment) {
        print(style.dim('  No deployment — this target runs wherever the CLI does.'));
        return;
      }

      print(`  ${deployment.platform} service ${style.bold(deployment.service)} in ${deployment.region}`);
      print(
        style.dim(
          "  the address is the platform's to assign — run: " +
            `lanes link outputs --workspace ${target} --profile ${profiles[0]?.name ?? '<name>'}`,
        ),
      );
    },
  );
}
