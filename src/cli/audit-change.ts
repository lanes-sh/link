import { openAudit, openSecrets, openStorage } from '#deployments/target.ts';
import { openTarget, type Config } from '#profile';
import { readSession } from '#auth/lanes/session.ts';

/**
 * Config changes, in the same log as the calls they permit.
 *
 * The audit log recorded capability invocations and nothing else, which meant
 * it could answer "what did this agent try to do" and could not answer "who
 * changed what it was allowed to do". Those are halves of one investigation. A
 * member added by hand at 14:02 and the first call that member made at 14:03
 * are one story, and keeping them in two places means reconstructing the join
 * by timestamp across two formats — so they go in one chain, in order, and
 * `audit verify` covers both.
 *
 * **The event shape does not change.** A config change is written as an
 * invocation of a capability that only the CLI can invoke, which is true rather
 * than a convenient fiction: `config.member.add` is a thing that was done, by
 * someone, to something, with arguments worth keeping. Adding a second record
 * type would fork every reader, the chain encoding, and `tail`'s filters, to
 * express something the existing five fields already carry.
 *
 * **`provider: 'config'` is not a provider**, and `config.test.ts` asserts no
 * manifest may claim that id — the guarantee is a test rather than a comment,
 * because the day someone writes `providers.d/config.yaml` the two kinds of row
 * become indistinguishable in a log whose value is that they are not.
 *
 * **None of this is reachable over MCP.** These capabilities are not in the
 * registry, no profile can grant them, and `control-plane.test.ts` is the
 * standing check that config never becomes a surface an agent can call. Writing
 * a row about a change is not the same as offering to make one.
 *
 * **Failing to log never fails the command.** The change is already on disk by
 * the time this is called; throwing here would report failure for something
 * that succeeded, and leave the operator to guess which half happened. It warns
 * and returns.
 */

/**
 * The vocabulary, in one place so it cannot drift command by command.
 *
 * `<area>.<verb>`, with the area named for the thing that changed rather than
 * for the command that changed it — `lanes link connect` and a hand-edited
 * `connections.yaml` are the same event, and a log that called them different
 * things would be reporting the route rather than the change.
 */
export const CONFIG_CAPABILITIES = [
  'config.connection.create',
  'config.connection.remove',
  'config.connection.relabel',
  'config.profile.add',
  'config.profile.remove',
  'config.member.add',
  'config.member.remove',
  'config.policy.allow',
  'config.policy.deny',
  'config.pair.mint',
  'config.pair.rotate',
] as const;

export type ConfigCapability = (typeof CONFIG_CAPABILITIES)[number];

/** The pseudo-provider every config row carries. Reserved by `config.test.ts`. */
export const CONFIG_PROVIDER = 'config';

export interface ConfigChange {
  readonly capability: ConfigCapability;
  /**
   * The scope of the change: the profile it altered, or the workspace where it
   * altered something the whole workspace shares.
   *
   * A connection belongs to the workspace now (ADR-057), so `connect` has no
   * profile to name and naming one would be a guess. The workspace's own name
   * goes here instead — informative, and never mistakable for a profile,
   * because a reader who filters by a profile they have gets rows about it and
   * a reader who does not gets the workspace's.
   */
  readonly scope: string;
  /** `<provider>.<id>`, where the change was about one connection. */
  readonly connection?: string | undefined;
  /**
   * What changed, and it is the operator's own config rather than anybody's
   * content — so unlike a provider's arguments there is nothing here to redact.
   * Names, ids, subjects and capability patterns are the whole point of the
   * record. Do not put a credential in it.
   */
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
}

export async function recordConfigChange(
  config: Config,
  root: string,
  target: string,
  change: ConfigChange,
  warn?: (message: string) => void,
): Promise<void> {
  try {
    const resolved = await openTarget(root, target);
    const input = { declared: resolved.declared, config, root: resolved.workspaceRoot, target };
    const audit = openAudit(await openStorage(input, await openSecrets(input)));

    try {
      await audit.append({
        profile: change.scope,
        principal: await principal(),
        provider: CONFIG_PROVIDER,
        ...(change.connection ? { connection: change.connection } : {}),
        capability: change.capability,
        arguments: change.arguments ?? {},
        // Every one of these is written after the change is on disk, so there
        // is no denied case to record and no duration worth measuring: the
        // number would be how long a file write took, which answers nothing.
        authorization: 'allowed',
        status: 'ok',
        durationMs: 0,
      });
    } finally {
      await audit.close();
    }
  } catch (error) {
    warn?.(`the change was made but not recorded in the audit log: ${message(error)}`);
  }
}


/**
 * The vocabulary a data change is recorded under.
 *
 * Not a `config.*` name, and not a new one either: these are the capabilities
 * an agent would have called to make the same change over MCP. A memory entry
 * edited from the dashboard and one written by a connected client are the same
 * event about the same bytes, so they carry the same capability and one filter
 * over the log finds both (ADR-069).
 *
 * Closed, for the reason `CONFIG_CAPABILITIES` is closed: the log's value is
 * that its vocabulary is small enough to know.
 */
export const DATA_CAPABILITIES = [
  'memory.write',
  'memory.forget',
  'tasks.add',
  'tasks.remove',
  'assets.store',
  'assets.remove',
  'skills.manage.write',
  'skills.manage.remove',
  'entities.write',
  'entities.forget',
] as const;

export type DataCapability = (typeof DATA_CAPABILITIES)[number];

export interface DataChange {
  readonly capability: DataCapability;
  /** The owner-layer provider whose store changed, e.g. `lanes_memory`. */
  readonly provider: string;
  /** `<provider>.<id>`, so a row can be traced to the store it touched. */
  readonly connection: string;
  /**
   * Identifiers and shape, never the document.
   *
   * A write log that recorded the content would be a second copy of the thing
   * it describes, kept somewhere with different retention. What belongs here is
   * what changed and how much of it: the id, the store, the byte length,
   * whether something was replaced.
   */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * What the paired browser did to the owner's own data.
 *
 * The same sink and the same event shape as a config change, and for the same
 * reason: a change and the calls around it are one story and belong in one
 * chain. What differs is the provider and the principal. `provider` is the
 * owner-layer provider that owns the bytes rather than the `config`
 * pseudo-provider, because unlike a policy edit this really is an operation on
 * a store an agent can also reach.
 *
 * `principal` is the caller's to supply and is not the CLI session: a pairing
 * token authenticates the owner at a browser, and attributing its writes to
 * whoever last signed in at this terminal would be a guess presented as a fact.
 *
 * **Failing to log never fails the write**, which is `recordConfigChange`'s
 * rule and is right for the same reason: the bytes are already on the store by
 * the time this is called, and reporting failure for something that succeeded
 * leaves the operator to work out which half happened.
 */
export async function recordDataChange(
  runtime: {
    readonly config: Config;
    readonly resolution: { readonly workspaceRoot: string };
    readonly target: string;
  },
  principal: string,
  change: DataChange,
  warn?: (message: string) => void,
): Promise<void> {
  const root = runtime.resolution.workspaceRoot;

  try {
    const resolved = await openTarget(root, runtime.target);
    const input = {
      declared: resolved.declared,
      config: runtime.config,
      root: resolved.workspaceRoot,
      target: runtime.target,
    };
    const audit = openAudit(await openStorage(input, await openSecrets(input)));

    try {
      await audit.append({
        profile: runtime.config.instance.profile,
        principal,
        provider: change.provider,
        connection: change.connection,
        capability: change.capability,
        arguments: change.arguments,
        // Written after the bytes are on the store, so there is no denied case
        // to record and no duration worth measuring.
        authorization: 'allowed',
        status: 'ok',
        durationMs: 0,
      });
    } finally {
      await audit.close();
    }
  } catch (error) {
    warn?.(`the change was made but not recorded in the audit log: ${message(error)}`);
  }
}

/**
 * Who made the change.
 *
 * The signed-in Lanes subject, which since ADR-060 is a real person rather than
 * whoever held a token. `cli:unsigned` is the honest answer where there is no
 * session — some commands do not require one, and attributing their changes to
 * the last person who signed in on this machine would be worse than saying so.
 */
async function principal(): Promise<string> {
  const session = await readSession().catch(() => null);
  return session?.subject ?? 'cli:unsigned';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
