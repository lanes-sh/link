import type { ProviderManifest } from '#connectivity';
import { setupRequirements, type SetupRequirement } from '#connectivity';

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
  readonly id: string;
  readonly name: string;
  readonly description: string;
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
}

export interface PlanContext {
  readonly profile: string;
  /** Every configured connection this caller may see, as `provider.id`. */
  readonly connections: readonly string[];
}

export function planFor(
  manifest: ProviderManifest,
  context: PlanContext,
  connectionId?: string,
): ProviderPlan {
  const { requirements, needsId } = setupRequirements(manifest, connectionId, context.profile);

  const connected = context.connections.filter((key) => key.startsWith(`${manifest.id}.`));

  // `--profile` always, never conditionally. One endpoint serves every profile,
  // and the shell this command is pasted into may default to a different one —
  // which is exactly what `resolveSelection`'s "never a silent pick" rule
  // exists to prevent.
  const command =
    `lanes link connect ${manifest.id} --profile ${context.profile}` +
    (needsId ? ' --id <name>' : connectionId ? ` --id ${connectionId}` : '');

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    connected,
    multiAccount: manifest.auth.kind !== 'none',
    browser: manifest.auth.kind === 'oauth',
    ...(manifest.setup?.summary ? { summary: manifest.setup.summary } : {}),
    ...(manifest.setup?.docs_url ? { docsUrl: manifest.setup.docs_url } : {}),
    steps: manifest.setup?.steps ?? [],
    requires: requirements,
    needsId,
    command,
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
