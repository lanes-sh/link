import type { AnyConnector, ProviderManifest } from '#connectivity';
import { connectorFactory, type ConnectorFactory } from '#connectivity/transports';
import type { ProviderRegistry } from '#registry';

/** Only the fields this reads; the real row carries more. */
interface ConnectionRow {
  readonly provider: string;
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
}
import type { SecretStore } from '#secrets';
import type { Prompter } from '../../prompt.ts';

/**
 * Asking a connection where its service is.
 *
 * Only a provider that declares `variables` reaches this — a Zendesk-shaped host
 * that carries the tenant, or anything self-hosted. Everything else has one
 * address for everybody and is never asked anything here.
 *
 * Asked *before* the account is settled, and that ordering is forced rather than
 * chosen: settling the identity means calling the service, and there is nothing
 * to call until the address is known. It is also why the values cannot simply be
 * written to the connection row first — the row's id is not decided until the
 * identity comes back.
 */
export interface VariableValues {
  readonly [key: string]: string;
}

export async function askForVariables(input: {
  readonly manifest: ProviderManifest;
  readonly prompter: Prompter;
  /** Values already on the row, when reconnecting. Offered as the default. */
  readonly existing?: Readonly<Record<string, unknown>> | undefined;
  /** With nobody to ask, an absent value is a refusal rather than a prompt. */
  readonly interactive: boolean;
  /** From `--set key=value`, which is how a non-interactive run supplies one. */
  readonly supplied?: Readonly<Record<string, string>> | undefined;
}): Promise<VariableValues> {
  const { manifest, prompter, existing, interactive } = input;
  const supplied = input.supplied ?? {};
  if (manifest.variables.length === 0) return {};

  const values: Record<string, string> = {};

  for (const variable of manifest.variables) {
    // `--set` outranks what the row already carries: naming a value is how
    // somebody says the server moved.
    const previous = supplied[variable.key] ?? existing?.[variable.key];
    const known = typeof previous === 'string' && previous !== '' ? previous : undefined;

    if (!interactive) {
      if (!known) {
        throw new Error(
          `${manifest.name} needs to be told its ${variable.label} and there is nobody to ask. ` +
            `Give it on the command line: --set ${variable.key}=${variable.example}`,
        );
      }
      if (!new RegExp(variable.pattern).test(known)) {
        throw new Error(
          `"${known}" is not a usable ${variable.label} — it must look like ${variable.example}.`,
        );
      }
      values[variable.key] = known;
      continue;
    }

    // The description goes in the question rather than beside it: `Prompter.ask`
    // takes one string, and a hostname nobody can guess needs the sentence that
    // says where to find it.
    const answer = (
      await prompter.ask(
        `${variable.description}\n${variable.label}${known ? ` [${known}]` : ` (e.g. ${variable.example})`}`,
      )
    ).trim();

    const chosen = answer === '' ? known : answer;
    if (!chosen) {
      throw new Error(`${manifest.name} cannot be reached without its ${variable.label}.`);
    }

    // Checked here as well as at substitution, so a mistyped subdomain is a
    // question asked again rather than a connection that is written and then
    // fails on its first call. `applyVariables` is still the one that matters —
    // it guards the value a *file* supplies, which never passes through here.
    if (!new RegExp(variable.pattern).test(chosen)) {
      throw new Error(
        `"${chosen}" is not a usable ${variable.label} — it must look like ${variable.example}. ` +
          `The value goes into the address this connection calls, so anything that could change ` +
          `the host is refused.`,
      );
    }

    values[variable.key] = chosen;
  }

  return values;
}

/**
 * The address a provider was last given, from whichever of its connections has one.
 *
 * Also reached across a family: `nextcloud_calendar` and `nextcloud_contacts`
 * are two providers on one server, and the setup steps tell people to connect
 * them together — so being asked the same hostname twice is the thing to avoid.
 * They are matched on sharing a credential app, which is already how "one
 * account, several providers" is expressed.
 */
function previousAddress(
  connections: readonly ConnectionRow[],
  providerId: string,
  manifest: ProviderManifest,
): Readonly<Record<string, unknown>> | undefined {
  const family = manifest.auth.kind === 'basic' ? manifest.auth.app : undefined;

  const mine = connections.find(
    (connection) => connection.provider === providerId && connection.config,
  );
  if (mine) return mine.config;

  if (!family) return undefined;

  return connections.find(
    (connection) => connection.provider.startsWith(`${family}_`) && connection.config,
  )?.config;
}

export interface ResolvedAddress {
  /** What the connection will store under `config`. Empty for a fixed-address provider. */
  readonly values: VariableValues;
  /** The factory the identity probe and discovery should use. */
  readonly connectorFor: (providerId: string, connectionId: string) => AnyConnector | undefined;
  /** Only ever a scoped factory; the runtime's own is never closed by this. */
  close(): Promise<void>;
}

/**
 * Everything a connect run needs in order to reach a service whose address it
 * has just been told.
 *
 * The scoped factory is the part worth explaining. The values belong to a
 * connection row that does not exist yet — the row is written at step 4, and
 * the id it will carry is not settled until step 2 — so there is nowhere for
 * the runtime's own lookup to read them from. Rather than write a provisional
 * row and rename it, this run gets a factory of its own holding the values
 * directly. The runtime's factory is untouched, which matters because its cache
 * is what keeps a stateful connector a single instance.
 *
 * A provider with no variables gets the runtime's factory back and no second
 * cache, so the ordinary path is exactly as it was.
 */
export async function resolveConnectionAddress(input: {
  readonly manifest: ProviderManifest;
  readonly prompter: Prompter;
  readonly providerId: string;
  readonly provisionalId: string;
  readonly interactive: boolean;
  /** `--set key=value`, as the parser hands it over: absent, one, or many. */
  readonly set?: readonly string[] | string | undefined;
  readonly runtime: {
    readonly registry: ProviderRegistry;
    readonly credentials: SecretStore;
    readonly config: { readonly connections: readonly ConnectionRow[] };
    connectorFor(providerId: string, connectionId: string): AnyConnector | undefined;
  };
}): Promise<ResolvedAddress> {
  const { manifest, runtime } = input;

  const values = await askForVariables({
    manifest,
    prompter: input.prompter,
    // What was said last time, offered as the default.
    //
    // Not keyed on the provisional id, which is `pending` unless `--id` was
    // given — so the lookup almost never hit and every reconnect asked for the
    // server address again. Any declared connection of this provider will do:
    // the id is not settled yet, and a second Nextcloud on a *different* host is
    // rarer than reconnecting the one there is. It is offered, not imposed —
    // pressing Enter accepts it and typing replaces it.
    existing: previousAddress(runtime.config.connections, input.providerId, manifest),
    interactive: input.interactive,
    supplied: parseSet(input.set),
  });

  if (manifest.variables.length === 0) {
    return {
      values,
      connectorFor: runtime.connectorFor.bind(runtime),
      close: async () => {},
    };
  }

  const scoped: ConnectorFactory = connectorFactory({
    registry: runtime.registry,
    credentials: runtime.credentials,
    connectionConfig: () => values,
  });

  return { values, connectorFor: scoped, close: () => scoped.closeAll() };
}

/**
 * `--set key=value` into a map, refusing anything that is not a pair.
 *
 * A flag given once arrives as a string and twice as an array, which is the
 * parser's shape rather than a choice here.
 */
export function parseSet(input: readonly string[] | string | undefined): Record<string, string> {
  const given = input === undefined ? [] : typeof input === 'string' ? [input] : input;
  const values: Record<string, string> = {};

  for (const entry of given) {
    const at = entry.indexOf('=');
    if (at <= 0) throw new Error(`--set wants key=value, and got "${entry}".`);
    values[entry.slice(0, at)] = entry.slice(at + 1);
  }

  return values;
}
