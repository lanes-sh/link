import type { ProviderManifest } from './provider.ts';
import type { SetupPrompt } from './setup.ts';
import { credentialRefForConnection } from './credential-ref.ts';

/**
 * What a provider needs in the credential store before `connect` can finish.
 *
 * Derived from the manifest's setup prompts and nothing else — pure, with no
 * store access — because three callers have to agree on the answer: the
 * non-interactive preflight in `connect`, `lanes link setup plan`, and the
 * read-only `setup.provider` capability. If the tool that tells someone what to
 * run computed this differently from the command they then run, the command
 * would not work, and the failure would look like a bug in `connect`.
 *
 * The split between here and `missingRequirements` is the one that matters:
 * this file says what setup *requires*, which is a property of shipped code.
 * Whether a value is *satisfied* needs the credential store, and only the CLI
 * ever asks that — ADR-007.
 */

/** The placeholder id used when no connection has been named yet. */
export const UNNAMED_ID = '<id>';

export interface SetupRequirement {
  /** Where the value goes. */
  readonly ref: string;
  /** What the value is, in the manifest's own words. */
  readonly label: string;
  readonly secret: boolean;
  readonly scope: 'shared' | 'connection';
  /** The prompt keys this one ref covers — two, for `basic`. */
  readonly prompts: readonly string[];
  /** The exact command that stores it. */
  readonly command: string;
}

export interface SetupNeeds {
  readonly requirements: readonly SetupRequirement[];
  /**
   * A connection-scoped value cannot be placed without an id.
   *
   * The ref derives from the connection id, which `connect` does not settle
   * until it has asked the provider whose account the credential belongs to.
   * Without `--id` the ref would be `<provider>/pending`, which is never what
   * anyone wants — so a non-interactive run has to be told the name up front.
   */
  readonly needsId: boolean;
  /**
   * The client comes from a broker, so there is nothing here to supply.
   *
   * Distinct from an empty `requirements`: a provider that needs nothing and a
   * provider whose client somebody else operates read the same in a list of
   * requirements and mean different things to a person deciding what to do
   * next. A form built from this would render a required field for a value
   * `connect` will never ask for.
   */
  readonly brokered: boolean;
  /**
   * What `--auth pasted_token` would ask for, where the provider offers it.
   *
   * Separate from `requirements` because it is an alternative rather than a
   * prerequisite: nothing needs it unless the browser route is closed to you.
   * Reported only when it is *not* the chosen route, since when it is chosen it
   * is a requirement above and naming it twice would read as two values.
   */
  readonly pastedCredential: string | undefined;
}

/**
 * Build the `secrets set` line for one ref.
 *
 * Spelled exactly as `secrets set` spells it in its own errors, because a
 * command someone is told to paste and a command the CLI suggests should not be
 * two different sentences.
 */
function storeCommand(ref: string, placeholder: string, where: Selection): string {
  return (
    `printf %s "${placeholder}" | lanes link secrets set ${ref}` +
    ` --profile ${where.profile} --workspace ${where.target}`
  );
}

/**
 * Which store a suggested command should write into.
 *
 * One object rather than two positional strings, because the pair travels
 * together everywhere and a caller that transposed them would produce a command
 * that runs, writes a credential, and puts it somewhere nobody looks.
 */
export interface Selection {
  readonly profile: string;
  readonly target: string;
}

/** How the value is spelled, for a ref that several prompts combine into. */
function placeholderFor(prompts: readonly SetupPrompt[]): string {
  const username = prompts.find((prompt) => prompt.field === 'username');
  const password = prompts.find((prompt) => prompt.field === 'password');

  // RFC 7617's own encoding, which is what `ensureStaticCredential` writes.
  // Showing `<value>` here would be a command that stores half a credential.
  if (username && password) return '<username>:<password>';

  return '<value>';
}

/**
 * What the key route needs, which is the key and nothing else.
 *
 * Never `needsId`, and that is the substantive difference from the block below:
 * the key is shared across every connection of a vendor, so its ref does not
 * derive from a connection id and nothing has to be named before it can be
 * stored. The subject does derive per connection — but it is not a requirement
 * because it cannot be placed ahead of time: it lives inside the pointer that
 * `connect` itself writes, and there is no `secrets set` that would put it
 * there.
 */
function assertionRequirements(
  assertion: NonNullable<Extract<ProviderManifest['auth'], { kind: 'oauth' }>['assertion']>,
  where: Selection,
): SetupNeeds {
  const shared = assertion.setup.prompts.filter((prompt) => prompt.scope === 'shared');

  return {
    requirements: shared.map((prompt) => ({
      ref: assertion.key_ref,
      label: prompt.label,
      secret: prompt.secret,
      scope: 'shared' as const,
      prompts: [prompt.key],
      command: storeCommand(assertion.key_ref, '<value>', where),
    })),
    needsId: false,
    brokered: false,
    pastedCredential: undefined,
  };
}

/**
 * Whether the manifest describes an OAuth client of the operator's own.
 *
 * `defineProvider` permits a broker, or a shipped client id, with no client
 * prompts — a provider with no bring-your-own path is a legal thing to be. Every
 * surface that offers that path has to ask this first, or it offers a route with
 * nothing behind it: the chooser, the client resolver, and the setup plan.
 *
 * Here rather than in any of the three because it was already written twice in
 * two different components under two different names, and this change would
 * have made it three.
 */
export function hasOwnClientPath(manifest: ProviderManifest): boolean {
  return (manifest.setup?.prompts ?? []).some((prompt) => prompt.scope === 'shared');
}

export function setupRequirements(
  manifest: ProviderManifest,
  connectionId: string | undefined,
  where: Selection,
  options: {
    /** `oauth_apps` entries this profile declares — the clients that are its own. */
    readonly ownClients?: readonly string[];
    /**
     * Which way in, for a provider offering two.
     *
     * Defaults to the browser flow, which is every provider's only route until
     * one declares `auth.assertion` — so an omitted value reports exactly what
     * it always reported. Passed by `connect` once the operator has chosen,
     * because the two methods need different things and reporting the union
     * would tell someone to store a client they are not going to use.
     */
    readonly method?: 'oauth' | 'assertion' | 'pasted';
  } = {},
): SetupNeeds {
  const assertion = manifest.auth.kind === 'oauth' ? manifest.auth.assertion : undefined;

  if (options.method === 'assertion' && assertion) {
    return assertionRequirements(assertion, where);
  }

  const prompts = manifest.setup?.prompts ?? [];

  // A shared prompt exists to collect a client the operator registers. When a
  // broker supplies one and this profile has not declared its own, there is
  // nothing to collect — the prompts stay in the manifest because `--own-client`
  // still needs them, but they are not what this connect will ask for.
  const brokered =
    manifest.auth.kind === 'oauth' &&
    manifest.auth.broker !== undefined &&
    !(manifest.auth.app !== undefined && (options.ownClients ?? []).includes(manifest.auth.app));

  const shared = brokered ? [] : prompts.filter((prompt) => prompt.scope === 'shared');

  // An OAuth provider's per-connection prompt belongs to one route, not to the
  // provider — it is what `--auth pasted_token` asks for, and nothing the
  // browser route ever needs. Reporting it either way would put a
  // mandatory-looking field in front of somebody whose whole path is a browser
  // round trip, which is the same mistake `brokered` avoids one line above.
  //
  // No OAuth manifest had one of these until Slack kept its pasted token as the
  // way past a workspace that has not approved the Lanes app.
  const connectionPrompts = prompts.filter((prompt) => prompt.scope === 'connection');
  const routed = manifest.auth.kind !== 'oauth' || options.method === 'pasted';

  const pasted = routed ? [] : connectionPrompts;
  const perConnection = routed ? connectionPrompts : [];

  const requirements: SetupRequirement[] = [];

  // A shared prompt names its own ref: nothing about a connection identifies an
  // OAuth client, so the manifest has to say where it lives.
  for (const prompt of shared) {
    if (!prompt.credential_ref) continue;
    requirements.push({
      ref: prompt.credential_ref,
      label: prompt.label,
      secret: prompt.secret,
      scope: 'shared',
      prompts: [prompt.key],
      command: storeCommand(prompt.credential_ref, '<value>', where),
    });
  }

  // Connection-scoped prompts derive one ref, and `basic` puts two answers in
  // it. Grouping by the resolved ref rather than emitting one requirement per
  // prompt is what keeps the emitted command correct for iCloud, where two
  // separate `secrets set` calls would leave the second overwriting the first.
  if (perConnection.length > 0) {
    const ref = credentialRefForConnection(manifest, connectionId ?? UNNAMED_ID);

    if (ref) {
      requirements.push({
        ref,
        label: perConnection.map((prompt) => prompt.label).join(', then '),
        secret: perConnection.some((prompt) => prompt.secret),
        scope: 'connection',
        prompts: perConnection.map((prompt) => prompt.key),
        command: storeCommand(ref, placeholderFor(perConnection), where),
      });
    }
  }

  return {
    requirements,
    needsId: perConnection.length > 0 && connectionId === undefined,
    brokered,
    pastedCredential:
      pasted.length > 0 ? pasted.map((prompt) => prompt.label).join(', then ') : undefined,
  };
}
