import { connectionSummaries, type ConnectionSummary } from '#cli/commands/connection-list.ts';
import { createProfile } from '#cli/commands/profile.ts';
import { grantConnection, revokeConnection, type Granted } from '#cli/commands/grant.ts';
import { applyPolicyRule } from '#cli/commands/operate/policy.ts';
import { addMemberTo, removeMemberFrom } from '#cli/commands/members.ts';
import { removeProfile } from '#cli/commands/profile/remove.ts';
import { declareConnection } from '#cli/commands/connect/declare.ts';
import { ConfigDocument } from '#cli/config-edit.ts';
import { openSecretStoreFor } from '#cli/runtime.ts';
import {
  CONNECTIONS_FILE,
  readConnections,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { loadProfileConfig, loadWorkspaceProfiles } from '#profile';
import { agentMayManage } from './authorise.ts';
import { MANAGED_TARGET } from './workspace.ts';

/**
 * The commands the control plane runs, and the seam a test replaces.
 *
 * Every function here calls the same code `lanes link` calls — `createProfile`,
 * `grantConnection`, `connectionSummaries` — rather than a second
 * implementation of it. That is the whole reason the control plane lives in
 * this repository: the alternative was reimplementing the config format in
 * Python, which is two answers to one schema and a migration Python would have
 * to track.
 *
 * They take an `env` because a terminal has one workspace in view and this
 * process does not. See `./workspace.ts`.
 *
 * Separated from `./routes.ts` when that file crossed the budget, along the seam
 * it already had: which route answers and what it may reach are different
 * subjects, and this is the one a route test replaces wholesale.
 */

export type { ConnectionSummary, Granted };

/** A profile as the control plane reports it: shape, never content. */
export interface ProfileSummary {
  readonly name: string;
  readonly grants: number;
  readonly members: number;
}

export interface ProfilesResult {
  readonly profiles: readonly ProfileSummary[];
  /** Named rather than dropped: a profile that will not parse is the answer. */
  readonly unreadable: readonly { profile: string; reason: string }[];
}

/**
 * What a route needs from a workspace, injectable at the composition root.
 *
 * The defaults are the real readers. They are parameters because a route test
 * is about the gate — who is turned away, and which root the reader was handed
 * — and standing a workspace up on disk to assert a 403 would test the fixture.
 */
export interface WorkspaceReaders {
  connections(root: string): Promise<readonly ConnectionSummary[]>;
  profiles(root: string): Promise<ProfilesResult>;
}

/**
 * What a mutation needs, injectable for the same reason the readers are.
 *
 * A route test is about the gate — who is refused, and which workspace the
 * writer was pointed at. Standing a real workspace up on disk to assert a 403
 * would be testing the fixture.
 */
export interface WorkspaceWriters {
  create(
    name: string,
    options: { targets: readonly string[]; nonInteractive?: boolean; env?: Record<string, string | undefined> },
  ): Promise<{ name: string; path: string }>;
  grant(
    connection: string,
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<Granted | null>;
  /**
   * Whether this profile is open to being changed by an agent.
   *
   * Its own reader rather than folded into the writers, because it is asked
   * *before* a mutation runs and must be answerable without one.
   */
  agentMayManage(profile: string, env: Record<string, string | undefined>): Promise<boolean>;
  revoke(
    connection: string,
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<boolean>;
  policy(
    effect: 'allow' | 'deny',
    capability: string,
    connection: string,
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<{ profile: string; capability: string; effect: 'allow' | 'deny' } | null>;
  addMember(
    subject: string,
    role: 'owner' | 'member',
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<{ profile: string; subject: string; role: string } | null>;
  removeMember(
    subject: string,
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<boolean>;
  removeProfileNamed(
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<{ profile: string; survived: number }>;
  storeConnection(
    provider: string,
    account: string,
    credential: string,
    profile: string,
    env: Record<string, string | undefined>,
  ): Promise<{ connection: string; account: string }>;
}

export const liveWriters: WorkspaceWriters = {
  create: (name, options) => createProfile(name, options),
  grant: (connection, profile, env) =>
    grantConnection(connection, { profile, target: MANAGED_TARGET }, { env }),
  revoke: (connection, profile, env) =>
    revokeConnection(connection, { profile, target: MANAGED_TARGET }, { env }),

  policy: (effect, capability, connection, profile, env) =>
    applyPolicyRule(effect, capability, { profile, target: MANAGED_TARGET, connection }, { env }),

  addMember: (subject, role, profile, env) =>
    addMemberTo(subject, role, { profile, target: MANAGED_TARGET }, { env }),

  removeMember: (subject, profile, env) =>
    removeMemberFrom(subject, { profile, target: MANAGED_TARGET }, { env }),

  async removeProfileNamed(profile, env) {
    // `yes` because nobody is at a terminal to confirm, and a prompter that
    // reports itself non-interactive so a command that would ask refuses
    // instead of blocking on a stdin that will never answer.
    const outcome = await removeProfile(
      profile,
      {
        profile,
        target: MANAGED_TARGET,
        yes: true,
        deleteData: true,
        prompter: {
          interactive: false,
          // Nobody is at a terminal, so a command that reaches for one has
          // asked a question with no answer. Refusing beats returning a guess.
          ask: async () => {
            throw new Error('A control-plane call cannot prompt.');
          },
          askSecret: async () => {
            throw new Error('A control-plane call cannot prompt.');
          },
          confirm: async () => false,
        },
      },
      { env },
    );
    // Null means it declined to run at all, which for a non-interactive call
    // with `yes` set is a state that should not arise — reported as a failure
    // rather than as a silent success.
    if (outcome === null) throw new Error(`Removing "${profile}" did not run.`);
    return { profile: outcome.profile, survived: outcome.survived };
  },

  /**
   * Store an account somebody just authorised, and grant it to a profile.
   *
   * The end of connecting rather than the whole of it. The api ran the
   * exchange — it holds the broker client secrets, it is the only party with a
   * browser session, and it is where the callback lands. What arrives here is
   * the result.
   *
   * The credential goes in before the row. A row naming a credential that is
   * not there is a connection that loads and then fails on its first call,
   * which reads as a broken account rather than an interrupted setup; the
   * reverse leaves an orphaned secret, which is invisible and harmless.
   */
  async storeConnection(provider, account, credential, profile, env) {
    const local = resolveWorkspaceRoot({ env });
    const root = await resolveTargetWorkspace(local, MANAGED_TARGET);

    const held = (await readConnections(root)).connections;
    // The id derives from the account, so reconnecting the same one repairs the
    // row rather than adding a second (ADR-068: a credential names a person).
    const existing = held.find((one) => one.provider === provider && one.account === account);
    const id = existing?.id ?? nextConnectionId(held, provider);

    // `<provider>/<id>` is where the provider already looks, which is why no
    // `credential_ref` is written beside the row.
    const secrets = await openSecretStoreFor(root, MANAGED_TARGET);
    await secrets.set(`${provider}/${id}`, credential);

    const document = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
    declareConnection({
      document,
      connections: held,
      providerId: provider,
      connectionId: id,
      account,
      label: account,
      defaultLabel: account,
      method: undefined,
      config: {},
    });
    await document.save();

    // Connecting authorises the account *and* grants it to the profile that
    // asked, which is what `lanes link connect --profile` does. Reaching it
    // from a second profile is then a grant rather than a second consent.
    await grantConnection(`${provider}.${id}`, { profile, target: MANAGED_TARGET }, { env });

    return { connection: `${provider}.${id}`, account };
  },

  async agentMayManage(profile, env) {
    const root = env['LANES_LINK_HOME'];
    if (root === undefined) throw new Error('No workspace root for this request.');
    const { config } = await loadProfileConfig(root, profile);
    return agentMayManage(config);
  },
};

export const liveReaders: WorkspaceReaders = {
  connections: (root) => connectionSummaries(root),
  async profiles(root) {
    const { loaded, unreadable } = await loadWorkspaceProfiles(root);
    return {
      profiles: loaded.map((one) => ({
        name: one.profile,
        grants: one.config.grants.length,
        members: one.config.members.length,
      })),
      unreadable,
    };
  },
};

/**
 * The next free id for a provider, as a number rather than a name.
 *
 * An id is opaque since ADR-067 and derives from nothing the operator types, so
 * the only property that matters is that it is free. Counting up rather than
 * hashing the account keeps it short and keeps two accounts at the same address
 * from colliding.
 */
function nextConnectionId(
  held: readonly { provider: string; id: string }[],
  provider: string,
): string {
  const taken = new Set(held.filter((one) => one.provider === provider).map((one) => one.id));
  for (let at = 1; ; at += 1) {
    const candidate = `con${at}`;
    if (!taken.has(candidate)) return candidate;
  }
}
