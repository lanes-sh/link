import { z } from 'zod';
import { defineLocalProvider, keepKeys, type ProviderDefinition, type ProviderManifest } from '#connectivity';
import { planAll, planFor, type ProviderPlan } from './plan.ts';

/**
 * `setup` — what is connected, and what connecting something else would take.
 *
 * **Read-only by construction, and that is the whole design.** ADR-007 keeps
 * connection creation, credential writing, OAuth, and configuration mutation off
 * the MCP surface, because each authorises *future* agent behaviour and the
 * decision has to originate outside the agent. Describing what setup requires
 * authorises nothing: it is the same category as `tools/list`, which already
 * tells a caller what exists. ADR-019 records the argument.
 *
 * So there are two capabilities, both reads, and no write bundle. The absence is
 * a decision rather than an omission — see `provider.test.ts`, which asserts the
 * capability list holds nothing else.
 *
 * Everything it reports is either shipped code (which providers exist, what
 * their setup blocks say) or already visible to the same caller through
 * `tools/list`, the injected `profile` and `connection` enums, and the
 * unauthenticated `/health`. The one genuinely new fact is the account *label*
 * on a connection — `you@example.com` — and it is deliberate: a caller holding a
 * grant on `gmail.main` can already read that mailbox, which discloses the
 * address on the first message. Withholding it here while serving the mailbox
 * would be theatre, and the label is the entire point.
 *
 * What it must never report is whether a credential is *present*. That is the
 * requires/satisfied split: this surface says what setup needs, and only
 * `lanes link` says what is already there. `missingRequirements` is CLI-only for
 * exactly this reason.
 *
 * The names are load-bearing. `control-plane.test.ts` runs seven unanchored
 * patterns over every registered capability id, so `setup.connection_steps`
 * trips the `connect` pattern (`.connect` matches inside `.connection_`) and
 * `setup.credentials_needed` trips the credential one. `overview` and `provider`
 * are clean. Renaming either is not a cosmetic change.
 */

export interface SetupProviderOptions {
  /**
   * Which profile this instance serves.
   *
   * Stamped at construction because a handler cannot learn it: `makeHandler`
   * strips `profile` off the arguments before dispatch, and `ProviderContext`
   * does not carry it. Every emitted command needs it, so it has to arrive
   * here — one registry is built per profile, so each instance gets its own.
   */
  readonly profile: string;
  /**
   * Which target this instance's stores came from.
   *
   * Stamped at construction for the same reason `profile` is, and it travels no
   * further than the commands this provider emits — nothing here opens a store.
   */
  readonly target: string;
  /** Sibling profile names on this endpoint. Names only; already at `/health`. */
  readonly profiles?: readonly string[];
  /**
   * `oauth_apps` entries this profile declares.
   *
   * Configuration, not a credential: it names which vendors this profile holds
   * a client of its own for, never whether the client is stored. Reporting a
   * provider as needing nothing when the profile has in fact registered one
   * would send the owner to a command that then asks for two values.
   */
  readonly ownClients?: readonly string[];
  /** Every provider this build ships. Shipped code, identical for every caller. */
  readonly catalogue?: readonly ProviderManifest[];
  /**
   * Accounts this principal can actually reach, in this profile.
   *
   * A function, not a snapshot, so it is evaluated per call. Computed by the
   * caller because filtering it is a policy decision and `#providers` may not
   * import `#policy` — `open.ts` runs it through the same `allowedConnections`
   * the dispatcher enforces with and `mergeCapabilities` builds the connection
   * enum from. Computing it separately here is how discovery and enforcement
   * drift, and a leak in discovery is still a leak.
   */
  readonly reachable?: () => ReadonlyArray<{ key: string; provider: string; account: string }>;
}

export function createSetupProvider(options: SetupProviderOptions): ProviderDefinition {
  const catalogue = options.catalogue ?? [];
  const reachable = options.reachable ?? (() => []);

  const context = () => ({
    profile: options.profile,
    target: options.target,
    connections: reachable().map((connection) => connection.key),
    ...(options.ownClients ? { ownClients: options.ownClients } : {}),
  });

  return defineLocalProvider({
    id: 'setup',
    name: 'Setup',
    version: '1.0.0',
    description:
      'What this endpoint is connected to, and what connecting something else would involve. ' +
      'Read-only: nothing here writes configuration, stores a credential, runs a sign-in, or ' +
      'changes what is permitted — those are control-plane operations and stay in the CLI.',

    configSchema: z.object({}),
    connectionSchema: z.object({}),

    bundles: [
      {
        name: 'read',
        description: 'Describe what is set up. There is no write bundle, by design.',
        oauth_scopes: [],
        capabilities: ['overview', 'provider'],
        default: true,
      },
    ],

    capabilities: [
      {
        kind: 'tool',
        name: 'overview',
        title: 'What is set up',
        description:
          'List the accounts reachable in this profile and the providers that could be connected. ' +
          'Call this before answering any question about what you can reach, or before suggesting ' +
          'that something be set up.',
        inputSchema: z.object({}),
        // No arguments to redact.
        async handler(_input, handlerContext) {
          const connections = reachable();
          const plans = planAll(catalogue, context());

          return {
            content: [
              {
                type: 'text',
                text: renderOverview(options, connections, plans, handlerContext.connection.key),
              },
            ],
          };
        },
      },

      {
        kind: 'tool',
        name: 'provider',
        title: 'What connecting one provider takes',
        description:
          'The console steps, the values needed, and the exact command that connects it. ' +
          'Use this to tell the owner what to run — do not compose the command yourself.',
        inputSchema: z.object({
          id: z.string().min(1).describe('Provider id, as listed by setup_overview — e.g. "notion"'),
          connection: z
            .string()
            .optional()
            .describe('Name for the account, when the provider stores a credential per account'),
        }),
        // A provider id is a name this project ships, not the owner's data, so
        // it is worth recording verbatim: an audit line that cannot say which
        // provider was asked about answers very little. `connection` is a label
        // the caller chose and is type-marked with everything else.
        redact: keepKeys('id'),
        async handler({ id, connection }, _handlerContext) {
          const manifest = catalogue.find((candidate) => candidate.id === id);

          if (!manifest) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `No provider "${id}". Call setup_overview for the ids this endpoint knows.`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: renderProvider(planFor(manifest, context(), connection)) }],
          };
        },
      },
    ],
  });
}

function renderOverview(
  options: SetupProviderOptions,
  connections: ReadonlyArray<{ key: string; account: string; label?: string | undefined }>,
  plans: readonly ProviderPlan[],
  self: string,
): string {
  const lines: string[] = [`Profile "${options.profile}".`, ''];

  if (connections.length === 0) {
    lines.push('No accounts are connected and reachable here yet.');
  } else {
    lines.push('Connected and reachable:');
    for (const connection of connections) {
      // Account first, label in brackets. The other way round for a person
      // reading `status`, and deliberately not here: an agent choosing which
      // connection to call needs the identity, and "Work mail" is not one.
      lines.push(
        `  ${connection.key}  — ${connection.account}` +
          (connection.label && connection.label !== connection.account
            ? ` (${connection.label})`
            : ''),
      );
    }
  }

  // Anything already connected is filtered out by `connected`, and anything
  // configured but not granted never reached `reachable()` — so a denied
  // provider appears here as merely available, indistinguishable from one that
  // was never connected. That is ADR-007's "probing must not be an oracle".
  //
  // Both lists key off `plan.connected`, which is the policy-filtered set, and
  // never off the raw config. Keying the second one off what is *configured*
  // would say "gmail is connected" about a connection policy hides, which is
  // the oracle this is careful not to be.
  const available = plans.filter((plan) => plan.connected.length === 0);

  if (available.length > 0) {
    lines.push('', 'Could be connected:');
    for (const plan of available) {
      lines.push(`  ${plan.id}${plan.browser ? '  (needs a browser sign-in)' : ''} — ${plan.description}`);
    }
    lines.push('', 'For what one of them takes, call setup_provider with its id.');
  }

  // A provider used to vanish from this surface the moment it had one
  // connection, so "connect another Gmail account" — the question this exists
  // to answer — had no answer in the overview at all, and an agent reading it
  // would conclude none was possible and improvise. Saying so costs one line.
  const more = plans.filter((plan) => plan.connected.length > 0 && plan.multiAccount);

  if (more.length > 0) {
    lines.push(
      '',
      `Already connected, and able to hold a further account: ${more.map((plan) => plan.id).join(', ')}.`,
      'Connecting a second account is the same command again — call setup_provider with the id for it.',
    );
  }

  const siblings = (options.profiles ?? []).filter((name) => name !== options.profile);
  if (siblings.length > 0) {
    lines.push(
      '',
      `This endpoint also serves: ${siblings.join(', ')}. Pass that profile to see what it reaches.`,
    );
  }

  lines.push(
    '',
    'Setting anything up is done by the owner, in a terminal — this endpoint cannot do it. ' +
      'A connection they make is served here within moments of them making it.',
    `(reported for connection ${self})`,
  );

  return lines.join('\n');
}

function renderProvider(plan: ProviderPlan): string {
  const lines: string[] = [`${plan.name} — ${plan.description}`];

  if (plan.summary) lines.push('', plan.summary);
  if (plan.docsUrl) lines.push(plan.docsUrl);

  if (plan.connected.length > 0) {
    lines.push('', `Already connected here: ${plan.connected.join(', ')}.`);

    // Without this the reader has a list of existing accounts and a command,
    // and no way to know the command is the one that adds another rather than
    // the one that already ran.
    if (plan.multiAccount) {
      lines.push(
        'The command below adds another account rather than replacing those — ' +
          'each account is its own connection.',
      );
    }
  }

  // A console walkthrough is withheld from this surface when it does not apply.
  // A model handed nine steps it has no reason to relay will relay them, and
  // the owner ends up registering a client they did not need.
  if (plan.steps.length > 0 && !plan.brokered) {
    lines.push('', 'The owner does this first, in the vendor’s own console:');
    plan.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  }

  if (plan.brokered) {
    lines.push(
      '',
      `There is nothing to register: the OAuth client is operated by ${plan.clientOperator}, ` +
        'and its secret never reaches this machine. The command below is the whole of it.',
    );
  }

  // Labels, never the credential references they resolve to. The command below
  // *asks* for each of these, so the owner never needs to know where a value is
  // filed — and a ref names a key in the credential store, which is a detail of
  // ours rather than anything they can act on. The `secrets set` spelling exists
  // for `lanes link setup plan`, where the reader has a shell and is scripting.
  if (plan.requires.length > 0) {
    lines.push('', 'It will ask them for:');
    for (const requirement of plan.requires) lines.push(`  ${requirement.label}`);
  }

  if (plan.needsId) {
    lines.push(
      '',
      'This provider stores a credential per account, so the command needs a name for the ' +
        'account — replace <name> with whatever they want to call it.',
    );
  }

  lines.push('', 'The command:', `  ${plan.command}`);

  if (plan.brokered && plan.ownClientCommand) {
    lines.push(
      '',
      'If the owner would rather use an OAuth client they register themselves — some ' +
        'organisations require it — the same command takes --own-client and then asks for ' +
        `the client id and secret:`,
      `  ${plan.ownClientCommand}`,
    );
  }

  // An alternative, said as one. It is not a value the command above needs, and
  // rendering it beside the requirements — which is what it did before there
  // was anywhere else to put it — reads as a second mandatory step in a setup
  // whose whole selling point is that it has none.
  if (plan.tokenCommand && plan.pastedCredential) {
    lines.push(
      '',
      'If the browser path is refused — a workspace that has not approved this app, which an ' +
        `admin decides — the same command takes --auth pasted_token and asks for the ` +
        `${plan.pastedCredential}:`,
      `  ${plan.tokenCommand}`,
      '  The console steps for obtaining one are in the setup documentation above.',
    );
  }

  if (plan.browser) {
    lines.push(
      '',
      'That opens a browser for consent, so it has to be run by whoever owns the account. ' +
        'Give them the line above rather than trying to run it.',
    );
  }

  lines.push('', 'Once it is done this becomes reachable here, with nothing further to run.');

  return lines.join('\n');
}
