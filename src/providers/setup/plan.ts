import type { ProviderManifest } from '#connectivity';
import { hasOwnClientPath, RESERVED_PROVIDER_IDS, setupRequirements, type SetupRequirement } from '#connectivity';

/**
 * What connecting a provider involves, assembled from its manifest.
 *
 * One implementation, two consumers: `lanes link setup plan` renders it for a
 * terminal, and the `setup.provider` capability renders it for a model. Both
 * must emit the *same* command, because the model's job is to hand a person
 * something to paste — a tool that suggested a command the CLI would reject is
 * worse than one that suggested nothing.
 *
 * Nothing here reads the credential store. What a provider *requires* is a
 * property of shipped code; whether it is *satisfied* needs a store, and only
 * the CLI asks that — ADR-007.
 */

export interface ProviderPlan {
  /** Where the service is, for a provider whose address the connection supplies. */
  readonly variables: readonly {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly example: string;
  }[];
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * This provider is part of what a profile *is*, not an account it holds.
   *
   * The owner layer — `memory`, `skills`, `vault`, `setup`, `identity` — keyed off
   * `RESERVED_PROVIDER_IDS`, which is the same list the registry uses to stop a
   * third-party manifest claiming one of those ids.
   *
   * Reported because it is the fact a surface needs and cannot derive.
   * `multiAccount` is the nearest thing and it is not it: that is a credential
   * test, and `icloud_drive` is `auth: none` without being owner-layer at all. A
   * client wanting to group these, or to withhold a disconnect that would leave a
   * dangling policy grant, was left hardcoding the list — which then goes stale
   * the next time one is added here. This travels with the release instead.
   */
  readonly reserved: boolean;
  /** Connection keys of this provider already configured, e.g. `gmail.main`. */
  readonly connected: readonly string[];
  /**
   * Whether this provider holds accounts at all, and so can hold another.
   *
   * `auth.kind === 'none'` means there is no credential to key on a connection
   * id, so a second row would address the same thing the first does and "connect
   * another" is meaningless. Everything else derives `<provider>/<id>` (or the
   * `app` it shares), so a second account is a second `connect`.
   *
   * Read that as the credential test it is, not as "the owner layer". The owner
   * layer never reaches here — `catalogue` is `PROVIDER_MANIFESTS`, the shipped
   * third-party providers, and `memory`, `skills`, `vault` and `setup` are
   * registered separately and are not in it. The one manifest this actually
   * excludes is `icloud_drive`, which is `auth: none` because Apple exposes a
   * synced folder rather than a protocol: its root is a manifest field, so a
   * second connection would read the same files off the same Mac. Correct, and
   * for a reason worth stating, because the next `auth: none` provider added
   * with a per-connection identity would be excluded here silently and wrongly.
   *
   * This exists because the overview used to drop a provider entirely once it
   * had one connection, which made "connect another Gmail account" unanswerable
   * from the surface built to answer it.
   */
  readonly multiAccount: boolean;
  /**
   * Finishing this needs a person at a browser.
   *
   * The one fact that decides whether an agent can do it. Everything else is a
   * value that can be written to the store and then used.
   */
  readonly browser: boolean;
  readonly summary?: string;
  readonly docsUrl?: string;
  readonly steps: readonly string[];
  readonly requires: readonly SetupRequirement[];
  /** True when the command below needs `--id` filling in first. */
  readonly needsId: boolean;
  /** The one line that connects it. */
  readonly command: string;
  /**
   * The OAuth client is operated by somebody else, so `requires` is empty
   * because there is nothing to register — not because setup is trivial.
   */
  readonly brokered: boolean;
  /** Who operates that client, for the sentence shown before consent. */
  readonly clientOperator?: string;
  /** The line that opts out of it and registers one of your own instead. */
  readonly ownClientCommand?: string;
  /** What `--auth pasted_token` asks for, where that is a way in. */
  readonly pastedCredential?: string;
  /** The line that takes that way in. */
  readonly tokenCommand?: string;
}

export interface PlanContext {
  readonly profile: string;
  /**
   * Which target's stores the emitted command should act on.
   *
   * Stamped like `profile` is, and for a stronger reason: a connection's
   * credential lives in one target's store, so a `connect` that lands in the
   * wrong one authorises an account the endpoint asking for it cannot read.
   */
  readonly target: string;
  /** Every configured connection this caller may see, as `provider.id`. */
  readonly connections: readonly string[];
  /**
   * `oauth_apps` entries this profile declares.
   *
   * Which clients are the operator's own, so a profile that has registered one
   * is described as needing it rather than as needing nothing.
   */
  readonly ownClients?: readonly string[];
}

export function planFor(
  manifest: ProviderManifest,
  context: PlanContext,
  connectionId?: string,
): ProviderPlan {
  const { requirements, needsId, brokered, pastedCredential } = setupRequirements(
    manifest,
    connectionId,
    { profile: context.profile, target: context.target },
    { ...(context.ownClients ? { ownClients: context.ownClients } : {}) },
  );

  const connected = context.connections.filter((key) => key.startsWith(`${manifest.id}.`));

  // Both, always, never conditionally. One endpoint serves every profile and
  // each profile may declare several targets, and the shell this is pasted into
  // supplies neither — nothing but the command line does. An emitted command
  // missing either is one that refuses, or worse, writes a credential into a
  // store the endpoint that asked for it does not read.
  const command =
    `lanes link connect ${manifest.id} --profile ${context.profile} --workspace ${context.target}` +
    (needsId ? ' --id <name>' : connectionId ? ` --id ${connectionId}` : '');

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    reserved: RESERVED_PROVIDER_IDS.includes(manifest.id),
    connected,
    multiAccount: manifest.auth.kind !== 'none',
    browser: manifest.auth.kind === 'oauth',
    ...(manifest.setup?.summary ? { summary: manifest.setup.summary } : {}),
    ...(manifest.setup?.docs_url ? { docsUrl: manifest.setup.docs_url } : {}),
    steps: manifest.setup?.steps ?? [],
    requires: requirements,
    // Not a `requires` entry, and the difference is the point: a variable is not
    // a secret, has no ref, and no `secrets set` line would place it. It is
    // asked for at connect and written to the connection's own row.
    variables: manifest.variables,
    needsId,
    command,
    brokered,
    ...(pastedCredential
      ? { pastedCredential, tokenCommand: `${command} --auth pasted_token` }
      : {}),
    ...(brokered && manifest.auth.kind === 'oauth' && manifest.auth.broker
      ? {
          clientOperator: manifest.auth.broker.operator,
          // The steps stay in `steps` either way. A renderer decides whether to
          // show a console walkthrough for a path nobody has asked for; the
          // plan's job is to say the path exists and what opens it.
          //
          // Offered only where the manifest actually describes a client to
          // register. Slack's does not — it asks for a token, never for a
          // client id and secret — and `resolveOAuthClient` refuses the flag on
          // exactly that ground, so printing it here would be handing somebody
          // a command that answers back with "there is no such path".
          ...(hasOwnClientPath(manifest) ? { ownClientCommand: `${command} --own-client` } : {}),
        }
      : {}),
  };
}

export function planAll(
  manifests: readonly ProviderManifest[],
  context: PlanContext,
): ProviderPlan[] {
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((manifest) => planFor(manifest, context));
}

/**
 * One connection this profile can reach, as the overview renders it.
 *
 * Declared once rather than spelled structurally at both ends: the two literals
 * had to agree about `providerName`, and the display name went missing on one
 * side — which is how an owner row came to read "Memory (lanes_memory (Memory))".
 */
export interface ReachableConnection {
  readonly key: string;
  readonly provider?: string;
  /** The manifest's display name, which is what a label composes with. */
  readonly providerName?: string;
  readonly account: string;
  readonly label?: string | undefined;
}
