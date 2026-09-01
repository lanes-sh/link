import { RESERVED_PROVIDER_IDS } from '#connectivity';
import { credentialRefFor } from '#registry';
import {
  CONNECTIONS_FILE,
  listProfiles,
  loadProfileConfig,
  readConnections,
  type ConnectionConfig,
  type Resolution,
} from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { announce, announceWorkspace, emit, ok, print, style, warn } from '../output.ts';
import { openWorkspaceRuntime, type GlobalFlags } from '../runtime.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { confirm, isInteractive } from '../prompt.ts';

/**
 * `lanes link disconnect` and `lanes link relabel` — the two edits to an
 * existing connection that were not possible without opening the YAML.
 *
 * Both are control-plane commands under ADR-007: they write the profile config,
 * and `disconnect` also deletes from the target's credential store. Neither is
 * reachable through MCP, for the same reason `connect` is not.
 *
 * `disconnect` is the counterpart to `connect`, and deliberately not "delete":
 * the state record is left alone. Reconcile marks an undeclared connection
 * `disabled` rather than deleting it so the audit log keeps meaning something,
 * and a command that reached past that to erase the record would be undoing the
 * one guarantee the audit log offers.
 *
 * Each command is a data function plus a printing wrapper, the shape
 * `commands/identity.ts` uses: `--json` needs the facts without the rendering.
 */

/** Where a connection is, and what it says, before anything is changed. */
interface Located {
  readonly index: number;
  readonly connection: ConnectionConfig;
}

export interface Disconnected {
  readonly profile: string;
  readonly target: string;
  readonly key: string;
  readonly account: string;
  /**
   * The credential reference this removed, if it removed one. `null` when the
   * provider has none (the owner layer), when `--keep-credential` was passed, or
   * when a sibling connection still resolves to the same reference.
   */
  readonly credential: string | null;
  /** Set when the credential was left because something else still needs it. */
  readonly credentialSharedWith: readonly string[];
  /**
   * The profiles that lost a grant on this connection.
   *
   * Reported rather than counted, because a connection belongs to the workspace
   * (ADR-057) and the profiles that lose one are not the profile the command was
   * run against. Empty means it was granted by nobody, which is a legitimate
   * state for an account connected and not yet used.
   */
  readonly ungranted: readonly string[];
  /** Connections left in the workspace, not in the profile. */
  readonly remaining: number;
  readonly published: string;
}


export interface DisconnectFlags extends GlobalFlags {
  readonly yes?: boolean | undefined;
  readonly keepCredential?: boolean | undefined;
  readonly json?: boolean | undefined;
}


/**
 * Find the one connection a key names.
 *
 * The key must be exact — `gmail.main`, never `gmail`. `connect` accepts the
 * bare provider because it can then create an account and choose the id; there
 * is nothing to choose here, and a bare `gmail` with two accounts declared would
 * be a command guessing which one to throw away.
 */
export function locate(
  connections: readonly ConnectionConfig[],
  key: string,
  workspace: string,
): Located {
  if (!key.includes('.')) {
    const matches = connections.filter((one) => one.provider === key);
    throw new Error(
      `"${key}" names a provider, not a connection.\n` +
        (matches.length > 0
          ? `  This workspace holds ${matches.map((one) => `${one.provider}.${one.id}`).join(', ')}.\n`
          : '') +
        `  Run: lanes link connection list --workspace ${workspace}`,
    );
  }

  const index = connections.findIndex((one) => `${one.provider}.${one.id}` === key);
  if (index === -1) {
    throw new Error(
      `Workspace "${workspace}" holds no connection "${key}".\n` +
        `  Run: lanes link connection list --workspace ${workspace}`,
    );
  }

  return { index, connection: connections[index] as ConnectionConfig };
}

/**
 * Refuse to remove the last instance of a built-in surface, and say why.
 *
 * A reserved provider is a connection like any other now (ADR-059), so
 * `disconnect memory.acme` is a real thing to do and it works: the instance goes,
 * every profile's grant on it goes, and the bytes stay where `rm -r` can find
 * them.
 *
 * The *last* one is different, and refusing is honesty rather than caution. The
 * owner layer arrives granted and is repaired back into place on the next
 * `start`, `connect` or `deploy` (ADR-050), so removing the only `memory`
 * connection succeeds, prints a success line, and is undone by the next command
 * the operator runs. A command that reports a change the system immediately
 * reverses is worse than one that refuses.
 *
 * `deny` is the way off, and it always was — the same line ADR-050 documents.
 */
function refuseLastReserved(
  key: string,
  provider: string,
  connections: readonly ConnectionConfig[],
): void {
  if (!RESERVED_PROVIDER_IDS.includes(provider)) return;
  if (connections.filter((one) => one.provider === provider).length > 1) return;

  throw new Error(
    `"${key}" is the only ${provider} connection in this workspace.\n` +
      `  The owner layer is repaired back on the next start, connect or deploy, so removing it\n` +
      `  would report a change that the next command undoes.\n` +
      `  To take the surface away from a profile, deny it:\n` +
      `    lanes link policy deny "${provider}.*" --connection ${key} --profile <name>`,
  );
}

/**
 * Which other connections resolve to the same credential reference.
 *
 * The check exists because a reference is not always per connection. An OAuth
 * provider derives `<provider>/<id>` and is safe, but a manifest declaring
 * `credential_ref: mything/api_key` shares one reference across every connection
 * of that provider — so deleting it while a sibling still resolves to it would
 * take that sibling's credential with it, and the sibling would report
 * `unauthorized` for a `connect` nobody ran.
 */
export function connectionsSharingCredential(
  connections: readonly ConnectionConfig[],
  ref: string,
  exceptIndex: number,
  manifestFor: (provider: string) => Parameters<typeof credentialRefFor>[1],
): string[] {
  return connections
    .filter((one, i) => i !== exceptIndex && credentialRefFor(one, manifestFor(one.provider)) === ref)
    .map((one) => `${one.provider}.${one.id}`);
}

/**
 * Take the grant row back from a profile that named this connection.
 *
 * Exact, where this used to be a search. A rule named a *capability*, so
 * disconnecting the last Gmail meant hunting every rule whose capability began
 * `gmail.` and deciding whether it was now dangling — and getting that wrong
 * either left a config the loader refuses or silently dropped a rule about an
 * account that was still there. A grant names the connection (ADR-058), so
 * removing it is finding one row.
 *
 * Symmetry is still the argument. `connect` writes the connection and the
 * profiles that asked for it get a grant; a connection that goes takes its
 * grants with it, because a grant naming nothing is what
 * `assertGrantsResolve` refuses at load.
 *
 * Returns whether anything was removed, so the caller can report which profiles
 * it touched rather than claiming all of them.
 */
function dropGrantRow(document: ConfigDocument, key: string): boolean {
  const rows = document.getIn(['grants']) as { items?: unknown[] } | null;
  const doomed: number[] = [];

  (rows?.items ?? []).forEach((_row, at) => {
    if (document.getIn(['grants', at, 'connection']) === key) doomed.push(at);
  });

  // Descending, so each removal cannot move the index of one still to come.
  for (const at of doomed.reverse()) document.removeFrom(['grants'], at);
  return doomed.length > 0;
}

export async function removeConnection(
  key: string,
  flags: DisconnectFlags,
): Promise<{ resolution: Resolution; disconnected: Disconnected } | null> {
  const runtime = await openWorkspaceRuntime(flags);

  try {
    const { resolution, target } = runtime;
    const root = resolution.workspaceRoot;

    const connectionsFile = await readConnections(root);
    const located = locate(connectionsFile.connections, key, target);

    refuseLastReserved(key, located.connection.provider, connectionsFile.connections);

    // Which profiles lose a grant, computed before anything is asked, because it
    // is the fact that decides whether this is a small change or a large one. A
    // connection belongs to the workspace now (ADR-057), so disconnecting it
    // reaches every profile that named it — including ones the operator is not
    // thinking about, which is exactly why the confirmation lists them.
    const affected = await profilesGranting(root, key);

    if (!(await confirmed(key, affected, flags))) return null;

    const manifestFor = (provider: string) => runtime.registry.get(provider)?.manifest;
    const ref = credentialRefFor(located.connection, manifestFor(located.connection.provider));
    const shared = ref
      ? connectionsSharingCredential(connectionsFile.connections, ref, located.index, manifestFor)
      : [];

    // Grants first, then the connection. That order is the one the loader can
    // survive halfway through: a profile granting a connection that is gone is
    // refused at load, while a connection nothing grants is merely unused. So if
    // the process dies between the two writes, the workspace still opens.
    for (const profile of affected) {
      const document = await ConfigDocument.openKey(root, `profiles/${profile}.yaml`);
      if (dropGrantRow(document, key)) await document.save();
    }

    const connectionsDocument = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
    connectionsDocument.removeFrom(['connections'], located.index);
    await connectionsDocument.save();

    let removed: string | null = null;
    if (ref && shared.length === 0 && flags.keepCredential !== true) {
      await runtime.credentials.delete(ref);
      removed = ref;
    }

    return {
      resolution,
      disconnected: {
        profile: resolution.profile,
        target,
        key,
        account: located.connection.account,
        credential: removed,
        credentialSharedWith: shared,
        remaining: connectionsFile.connections.length - 1,
        ungranted: affected,
        published: nextAfterEdit(
          await publishProfileEdit({
            resolution,
            config: runtime.config,
            target,
            // Every profile that lost a grant, not just the one this ran under.
            // Publishing one left the bucket with a `connections.yaml` missing
            // the connection and a sibling still granting it — which
            // `assertGrantsResolve` refuses at load, so `openReconciled` skipped
            // that profile and it silently stopped being served.
            touched: [...new Set([resolution.profile, ...affected])],
          }),
        ),
      },
    };
  } finally {
    await runtime.close();
  }
}

/**
 * Every profile in the workspace whose grants name this connection.
 *
 * Read from the files rather than from the open runtime, which knows about one
 * profile. Reading them all is the point: the operator named a connection, and
 * the set of profiles that lose something is not visible from the one they
 * happen to have selected.
 */
async function profilesGranting(root: string, key: string): Promise<string[]> {
  const names = await listProfiles(root);
  const granting: string[] = [];

  for (const name of names) {
    const { config } = await loadProfileConfig(root, name);
    if (config.grants.some((grant) => grant.connection === key)) granting.push(name);
  }

  return granting;
}

/** A plain y/N. Not `profile remove`'s type-the-name, which guards the
 *  destruction of whole stores; this takes back one authorisation that `connect`
 *  can grant again. */
async function confirmed(
  key: string,
  affected: readonly string[],
  flags: DisconnectFlags,
): Promise<boolean> {
  if (flags.yes === true) return true;
  if (!isInteractive()) {
    throw new Error(
      `Disconnecting "${key}" deletes its credential, and stdin is not a terminal, so there is nobody to ask.\n` +
        `  Pass --yes to proceed.`,
    );
  }

  // The profiles are named in the question rather than printed above it. A
  // connection is the workspace's now, so "disconnect gmail.personal" can take
  // the account away from a profile the operator is not looking at, and the one
  // place that is certain to be read is the line they have to answer.
  const reach =
    affected.length === 0
      ? 'no profile grants it'
      : `${affected.length} profile(s) lose it: ${affected.join(', ')}`;

  // Defaults to no: this deletes a credential, and a stray return should not.
  return confirm(`Disconnect ${key} and delete its credential? (${reach})`, false);
}

export async function disconnect(key: string | undefined, flags: DisconnectFlags): Promise<void> {
  if (!key) throw new Error('Which connection? Run: lanes link status');

  const outcome = await removeConnection(key, flags);
  if (outcome === null) {
    print(warn('nothing was changed'));
    return;
  }
  const { resolution, disconnected: result } = outcome;

  return emit(flags.json, result, () => {
    announceWorkspace(resolution);
    print(ok(`disconnected ${style.bold(result.key)}${result.account ? ` (${result.account})` : ''}`));

    if (result.credential) {
      print(`      credential  ${style.dim(result.credential)} deleted`);
    } else if (result.credentialSharedWith.length > 0) {
      // Named rather than silent: the operator asked for a credential to go and
      // it did not, and the reason is a fact about their config.
      print(
        `      credential  kept — ${result.credentialSharedWith.join(', ')} still ${
          result.credentialSharedWith.length === 1 ? 'resolves' : 'resolve'
        } to it`,
      );
    }

    if (result.ungranted.length > 0) {
      print(`      ungranted   ${result.ungranted.join(', ')}`);
    }
    print(style.dim(`      ${result.remaining} connection(s) left in this workspace.`));
    // The state record survives on purpose, and the next reconcile is what marks
    // it disabled. Saying so stops "it is still in `status`" reading as a failure.
    print(
      style.dim(
        '      The state record stays until the next reconcile, which marks it disabled rather than deleting it.',
      ),
    );
    if (result.published) print(style.dim(`      ${result.published}`));
  })
}
