import { z } from 'zod';
import { defineLocalProvider, type ProviderDefinition } from '#connectivity';
import type { IdentityEntry } from '#profile';

/**
 * `identity` — who the owner is, for anything written as them.
 *
 * **Read-only by construction, for the same reason `setup` is.** ADR-007 keeps
 * configuration mutation off the MCP surface, and this block *is* configuration:
 * an agent that could rewrite whose name it signs with would be rewriting the
 * one fact that stops it signing wrong. Declaring it is the owner's, in a
 * terminal. So there is one capability, it is a read, and `provider.test.ts`
 * asserts the capability list holds nothing else.
 *
 * Reporting it authorises nothing, which is the ADR-019 argument again. A name
 * and an address are disclosed by the first message of any mailbox this endpoint
 * serves — a caller holding a grant on a mail connection already has them —
 * so withholding them here while serving the mailbox would be theatre. The
 * difference is that reading them *here* means not having to guess, and a guess
 * is what this exists to replace.
 *
 * Why it is its own provider rather than a third section of `setup_overview`:
 * policy. `identity.*` is a grant an owner can give or withhold on its own, so
 * an endpoint can describe what is connected without naming its owner, or name
 * its owner without describing what is connected. Folding it into `setup` would
 * have made those one decision, and they are not.
 *
 * `identity.list` is clean against the seven patterns in
 * `dispatch/control-plane.test.ts`. So is `identity` as a prefix. Neither is a
 * cosmetic name.
 */

export interface IdentityProviderOptions {
  /**
   * Which profile this instance serves.
   *
   * Stamped at construction for the reason recorded on `SetupProviderOptions`:
   * `makeHandler` strips `profile` off the arguments before dispatch and
   * `ProviderContext` does not carry it, so a handler cannot learn it. One
   * registry is built per profile, so each instance gets its own.
   */
  readonly profile: string;
  /**
   * Which target it is serving, for the command in the empty case.
   *
   * Needed for the same reason `setup`'s plans need it: `--profile` and
   * `--target` are required flags (ADR-037), and a command handed to an agent
   * without both is a paste that refuses. An agent pastes what it is given.
   */
  readonly target?: string;
  /**
   * What that profile declares, in declaration order.
   *
   * A snapshot rather than a function, unlike `setup`'s `reachable`. That one
   * has to be re-evaluated per call because policy is; this is config, and the
   * registry holding it is rebuilt whenever config is re-read — so an entry
   * added by the CLI is served after the next reload, exactly as a new
   * connection is, and a function here would only imply a freshness it could
   * not deliver.
   */
  readonly entries?: readonly IdentityEntry[];
}

export function createIdentityProvider(options: IdentityProviderOptions): ProviderDefinition {
  const entries = options.entries ?? [];

  return defineLocalProvider({
    id: 'identity',
    name: 'Identity',
    version: '1.0.0',
    description:
      'The names, addresses, and handles this profile declares for its owner, and a note on ' +
      'when each applies. Read-only: what is declared is set in the CLI, because an agent able ' +
      'to change whose name it signs with could change the one fact that stops it signing wrong.',

    configSchema: z.object({}),
    connectionSchema: z.object({}),

    bundles: [
      {
        name: 'read',
        description: 'Read the declared identity. There is no write bundle, by design.',
        oauth_scopes: [],
        capabilities: ['list'],
        default: true,
      },
    ],

    capabilities: [
      {
        kind: 'tool',
        name: 'list',
        title: 'Who the owner is, in this profile',
        description:
          'The names, addresses, and handles this profile declares for its owner, each with a ' +
          'note on when it applies. Call this before writing as them — signing a message, ' +
          'addressing one, choosing an account to act as — rather than inferring one from ' +
          'the conversation. A profile may declare several of a kind deliberately.',
        inputSchema: z.object({}),
        // No arguments to redact.
        async handler(_input, _handlerContext) {
          return {
            content: [{ type: 'text', text: render(options.profile, options.target, entries) }],
          };
        },
      },
    ],
  });
}

/**
 * Grouped by kind, in order of first appearance, and self-describing per line.
 *
 * Grouped because the failure this exists to prevent is a name used where an
 * address was wanted, and adjacency is most of what stops that. The kind is
 * repeated on every line anyway rather than written once as a heading: a line
 * lifted out of this block on its own then still says what it is, and a model
 * quoting one line is exactly what happens next.
 *
 * Order within a kind is declaration order, which is the owner's ranking.
 */
function render(
  profile: string,
  target: string | undefined,
  entries: readonly IdentityEntry[],
): string {
  if (entries.length === 0) {
    // Both flags, spelled out. They are required (ADR-037), so a command
    // missing either is one the owner pastes and watches refuse — and this is
    // handed to an agent, which relays it verbatim.
    const where = `--profile ${profile}${target ? ` --workspace ${target}` : ''}`;
    return (
      `Profile "${profile}" declares no identity.\n\n` +
      'Nothing here says what name or address to use, so do not invent one — ask. ' +
      `The owner declares them with \`lanes link identity add <kind> <value> ${where}\`.`
    );
  }

  const kinds = [...new Set(entries.map((entry) => entry.kind))];
  const ordered = kinds.flatMap((kind) => entries.filter((entry) => entry.kind === kind));

  const kindWidth = Math.max(...ordered.map((entry) => entry.kind.length));
  const valueWidth = Math.max(...ordered.map((entry) => entry.value.length));

  const lines = ordered.map((entry) => {
    const head = `  ${entry.kind.padEnd(kindWidth)}  ${entry.value}`;
    return entry.note ? `${head.padEnd(kindWidth + valueWidth + 4)}  — ${entry.note}` : head;
  });

  // Said here rather than left to the reader because "several names" is
  // otherwise ambiguous in the one direction that matters: a model handed two
  // with no ranking picks by position anyway, and may as well be told that
  // position is what it means.
  const several = kinds.some((kind) => entries.filter((entry) => entry.kind === kind).length > 1);

  return [
    `Identity for profile "${profile}".`,
    '',
    ...lines,
    '',
    several
      ? 'Where a kind holds more than one, the first is the default and the notes say when to ' +
        'prefer another. If none of them fits what you are doing, ask rather than combining them.'
      : 'Use these as written. If what you need is not here, ask rather than inferring it.',
  ].join('\n');
}
