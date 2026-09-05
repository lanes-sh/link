import { createMcpConnector } from '#connectivity/transports';
import { bearerTokenAsStored, CredentialOAuthProvider } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import { connectionForAccount, defaultConnectionLabel, sameAccount } from '#profile';
import type { ConnectionConfig, Config } from '#profile';
import type { AnyConnector, ProviderManifest } from '#connectivity';
import { nextConnectionId, resolveAccount } from '../../identity.ts';
import { introspectAccount } from '../../introspection.ts';
import { progress, style } from '../../output.ts';
import { PromptCancelled, terminalPrompter, type Prompter } from '../../prompt.ts';
import { accountSiblings } from './accounts.ts';

/**
 * Settle which connection this is, and whose account it belongs to.
 *
 * The order matters. An explicit `--id` wins, because someone who named it
 * meant it. Otherwise the provider is asked who authorised — and if an existing
 * connection already holds that account, we reuse *its* id, which is what turns
 * a re-run of `connect` into a repair rather than a duplicate. Only when
 * identity cannot be resolved at all do we ask.
 *
 * The *label* is settled last and separately, because it is the one thing here
 * the provider cannot answer. `account` is load-bearing three times over — the
 * reconnect match above, the id derived from it, and the `From` header
 * `gmail.send_message` writes — so the operator's own words for a connection
 * cannot be put there, and `label` is where they go instead.
 */
export async function settleIdentity(input: {
  manifest: ProviderManifest;
  provisionalId: string;
  explicitId: string | undefined;
  account: string | undefined;
  /**
   * The label, where the caller already has one.
   *
   * `--label`, and the family path: `connect icloud` is three `connect` runs on
   * one account, and asking what to call it once per service is asking the same
   * question three times.
   */
  label?: string | undefined;
  runtime: {
    config: Config;
    /** Every account the workspace holds, for sibling matching (ADR-057). */
    workspaceConnections: readonly ConnectionConfig[];
    credentials: SecretStore;
    registry: { manifest(id: string): ProviderManifest | undefined };
    connectorFor(providerId: string, connectionId: string): AnyConnector | undefined;
    authorizeRequest(providerId: string, connectionId: string, request: Request): Promise<Request>;
  };
  prompter?: Prompter;
}): Promise<{
  connectionId: string;
  account: string;
  label: string;
  /**
   * What this row is called with nobody's word for it, carried to the writer.
   *
   * `declareConnection` writes no label equal to it, for the reason it never
   * wrote one equal to the account: a line saying what the two lines above it
   * say is a line to read past forever. Returned rather than derived twice, so
   * the string the operator was offered and the string compared against it
   * cannot come apart.
   */
  defaultLabel: string;
}> {
  const { manifest, provisionalId, explicitId, runtime } = input;
  const prompter = input.prompter ?? terminalPrompter;

  // Siblings across the whole vendor account, not just this provider — so
  // connecting iCloud Calendar after iCloud Mail lands on the same id, and
  // therefore the same credential, rather than a second `will2`.
  const siblings = accountSiblings(manifest, runtime.workspaceConnections, runtime.registry);

  let account = input.account ?? null;

  // A connector-resolved identity is also the credential check — it is the name
  // the server *accepted* — so it is called outside `resolveAccount`, whose
  // catch-all would turn a rejected password into a polite "which account is
  // this?" and hand you a connection that cannot work.
  if (!account && manifest.identity?.kind === 'connector') {
    account = (await runtime.connectorFor(manifest.id, provisionalId)?.identify?.()) ?? null;
  }

  if (!account) {
    const token = () => bearerTokenAsStored(manifest, provisionalId, runtime.credentials);

    // Only where `accessToken` cannot answer: `requestAuthorizer` goes through
    // `credentialResolver`, which may *refresh* an OAuth token, and
    // `bearerTokenAsStored` is deliberately the connect-time variant that does
    // not. Leaving oauth and bearer on the token keeps refresh behaviour
    // exactly as it was; these three had no working path at all.
    const carriesItsOwnHeader =
      manifest.auth.kind === 'api_key' ||
      manifest.auth.kind === 'header' ||
      manifest.auth.kind === 'basic';

    account = await resolveAccount(manifest, {
      accessToken: token,
      ...(carriesItsOwnHeader
        ? {
            authorize: (request: Request) =>
              runtime.authorizeRequest(manifest.id, provisionalId, request),
          }
        : {}),
      // A protocol that authenticates by username has nothing to GET and no
      // tool to call — it knows, once the server has accepted the login.
      identify: async () =>
        (await runtime.connectorFor(manifest.id, provisionalId)?.identify?.()) ?? null,
      ...(manifest.connector.kind === 'mcp'
        ? {
            callTool: async (name: string, args: Record<string, unknown>) => {
              // Cast for the same reason `endpoint` already was: the
              // narrowing that reached this branch does not survive into the
              // closure. Named field by field rather than spread, so a future
              // connector field does not silently become a transport option.
              const mcp = manifest.connector as {
                endpoint: string;
                headers?: Record<string, string>;
              };
              const connector = createMcpConnector({
                endpoint: mcp.endpoint,
                ...(mcp.headers ? { headers: mcp.headers } : {}),
                accessToken: token,
              });
              return connector.invoke({ name, inputSchema: {}, description: '' } as never, args, {
                manifest,
                provider: undefined as never,
                authorize: async (request) => request,
              });
            },
          }
        : {}),
    });
  }

  // Nothing declared, or what was declared came back empty. Before asking, ask
  // the authorization server: RFC 7662 introspection needs no per-vendor
  // configuration, and it is the only automatic answer available to the
  // remote-MCP family, which is 75 of the 105 manifests and every one of them a
  // question the operator has been answering by hand. See `introspection.ts`
  // for why asking the server is allowed where reading the stored token is not.
  if (!account && manifest.auth.kind === 'oauth' && manifest.connector.kind === 'mcp') {
    const endpoint = manifest.connector.endpoint;
    const scopes = manifest.auth.scopes;
    account = await introspectAccount({
      resourceUrl: endpoint,
      accessToken: () => bearerTokenAsStored(manifest, provisionalId, runtime.credentials),
      clientInformation: () =>
        new CredentialOAuthProvider({
          manifest,
          connectionId: provisionalId,
          credentials: runtime.credentials,
          scopes,
        }).clientInformation(),
    });
  }

  // A provider that authenticates to nothing has no account to name, so asking
  // is a question with no answer — and one that needs a terminal, which makes an
  // otherwise scriptable connect interactive for no reason.
  //
  // The *label* is the provider's name; the *id* is `main`, like every other
  // first connection. Deriving the id from the label gave `memory.memory`,
  // `skills.skills`, `vault.vault` — and, on disk, a memory entry at
  // `memory/memory/…`. `memory.main` reads the way `gmail.main` does.
  const unaccounted = !account && manifest.auth.kind === 'none';
  if (unaccounted) account = manifest.name;

  // Whether the name we hold is one the operator has just typed, rather than one
  // a provider reported. It settles the label below: a name someone chose a
  // second ago does not need confirming against itself.
  let typed = false;

  // Whether they declined to name it at all. It reaches the id below: a row
  // nobody could name must not match another row nobody could name.
  let bypassed = false;

  if (!account) {
    // Nothing to go on. Asking beats inventing `main2`, and the answer is the
    // one piece of information the file cannot reconstruct later — which is
    // also why a non-interactive run refuses rather than making one up. An
    // invented label is the row an operator reads in `status` forever.
    if (!prompter.interactive) {
      throw new Error(
        `${manifest.name} could not report whose account this is, and this run is non-interactive.\n` +
          `  Nothing was written. Pass --display-name "<label>" to name it yourself.`,
      );
    }

    const answer = await askForAccount(manifest, prompter);
    account = answer.account;
    bypassed = answer.bypassed;
    typed = true;
  }

  // Every id in the workspace, not this provider's alone. An id is opaque now,
  // so a reader has nothing but the number to go on and two rows sharing one
  // across providers would be a needless second thing to hold in mind — and
  // `con3` naming exactly one row is what makes it usable in a refusal.
  const taken = runtime.workspaceConnections.map((candidate) => candidate.id);

  // The reconnect match is on the *account*, which is what tells a repair from
  // a second row. That is the whole reason `resolveAccount` runs before this:
  // without it a failed attempt appends rather than repairs, which is how
  // `Gmail main3` came to exist.
  //
  // **This provider's own row first, a sibling's id only after.** Both steps
  // are needed and they answer different questions. A sibling match is how one
  // Apple Account ends up as one id across three providers, sharing one
  // password — but it is an id for a row this provider does not have yet, and
  // `declareConnection` writes by `<provider>.<id>`. Asked as a single search
  // across the vendor it returned whichever row came first in the file, so
  // reconnecting a mailbox settled on the calendar's id, found no mail row
  // under it, and appended a second one beside the stale first.
  //
  // A bypassed row is excluded from that match on purpose. `unnamed` is not an
  // identity, so two of them are not evidence of the same account — matching
  // them would hand the second connect the first one's credential ref and
  // overwrite it. A fresh id says the only true thing available: these are two
  // rows, and nobody could say whether they are two accounts.
  const own = connectionForAccount(siblings, manifest.id, account)?.id;

  const connectionId =
    explicitId ??
    (unaccounted
      ? // A surface that authenticates to nothing still has one row per
        // provider. Its account is the provider's own name, so every connect of
        // it resolves the same string — and allocating regardless made a second
        // `connect example` a second row, `lan8` and `lan9` describing one
        // surface, which is the same duplicate under a different branch.
        (own ?? nextConnectionId(taken, true))
      : bypassed
        ? nextConnectionId(taken, false)
        : (own ??
          siblings.find((candidate) => sameAccount(candidate.account, account!))?.id ??
          nextConnectionId(taken, false)));

  const defaultLabel = defaultConnectionLabel(manifest.name, account);

  return {
    connectionId,
    account,
    defaultLabel,
    label: await settleLabel({
      given: input.label,
      fallback: defaultLabel,
      // What the row this is about to land on is already called. Looked up
      // across the whole vendor account rather than this provider alone, for the
      // reason `accountSiblings` exists: `connect icloud_calendar` adopts iCloud
      // Mail's id, and should adopt the name that goes with it too.
      //
      // This provider's own row first, for the reason the id above prefers one:
      // an id is shared across a family, so a bare search by id offers whichever
      // service is written first in the file — the calendar's name suggested for
      // the mailbox being reconnected.
      declared: (
        siblings.find(
          (candidate) => candidate.id === connectionId && candidate.provider === manifest.id,
        ) ?? siblings.find((candidate) => candidate.id === connectionId)
      )?.label,
      typed,
      prompter,
    }),
  };
}

/** The literal answer that skips the question, and what it stores instead. */
const BYPASS_ANSWER = 'blank';
const UNNAMED_ACCOUNT = 'unnamed';

/**
 * The one thing the file cannot reconstruct later, asked until it is answered.
 *
 * An empty answer used to be taken, and stored `${manifest.name} ${provisionalId}`
 * — the provider's name beside `pending`, an internal token for "no id yet".
 * That string then became the account, the default label, and the key a
 * reconnect matches on. Nobody chose it and nothing can be done with it.
 *
 * So an empty answer re-asks, and there is a way past for someone who meant it:
 * typing `blank`. That row is `unnamed` — honest, visibly not an address, and
 * `defaultConnectionLabel` reads it as `Notion (unnamed)`.
 *
 * Bounded rather than unbounded. A prompter that reports itself interactive and
 * then returns nothing forever is not hypothetical — a closed pipe does it —
 * and a connect that hangs is worse than one that refuses in the words the
 * non-interactive path already uses.
 */
async function askForAccount(
  manifest: ProviderManifest,
  prompter: Prompter,
): Promise<{ account: string; bypassed: boolean }> {
  const question = `Which account is this? ${style.dim('(the address or handle)')}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await prompter.ask(question)).trim();

    if (answer.toLowerCase() === BYPASS_ANSWER) return { account: UNNAMED_ACCOUNT, bypassed: true };
    if (answer) return { account: answer, bypassed: false };

    progress(
      style.dim(
        `  It is how a reconnect finds this row again, and what every list shows it as.`,
      ),
    );
    progress(style.dim(`  Type "${BYPASS_ANSWER}" to go without one.`));
  }

  throw new Error(
    `${manifest.name} could not report whose account this is, and none was given.\n` +
      `  Nothing was written. Answer the question, type "${BYPASS_ANSWER}" to go without a name, ` +
      `or pass --display-name "<name>".`,
  );
}

/**
 * What to call this connection, offering what it is already called.
 *
 * Asked on every interactive connect, not only where identity resolution failed.
 * That was the old behaviour and it had the case exactly backwards: the run that
 * could not name the account is the run where the operator has least to add,
 * and the run that resolved `ada@example.com` — where they may well want "Work
 * mail" — never asked at all.
 *
 * The suggestion is in the question and an empty answer takes it, so the cost of
 * always asking is one keystroke. Nothing addresses a connection by its label,
 * so there is no answer here that can break anything.
 *
 * **The suggestion is the provider and the account, not the account.** It was
 * the address alone, which made the label a second copy of the field beside it
 * — and left every surface that shows a name without one, because a default
 * that only repeats another line is a default nothing writes down.
 * `defaultConnectionLabel` is the whole rule and every reader derives the same
 * string from it.
 */
async function settleLabel(input: {
  given: string | undefined;
  declared: string | undefined;
  /** What this row is called when nobody says otherwise. */
  fallback: string;
  typed: boolean;
  prompter: Prompter;
}): Promise<string> {
  const { given, declared, fallback, typed, prompter } = input;

  if (given) return given;

  // A label already chosen wins over the derived one, so re-authorising an
  // expired credential does not quietly undo the operator's own word for the row.
  const suggestion = declared ?? fallback;

  if (typed || !prompter.interactive) return suggestion;

  try {
    return (
      (await prompter.ask(`What should this be called? ${style.dim(`[${suggestion}]`)}`)) ||
      suggestion
    );
  } catch (refusal) {
    // Ctrl-C is an answer: the operator stopped the command, and swallowing it
    // here would finish a connect they interrupted.
    if (refusal instanceof PromptCancelled) throw refusal;

    // Anything else is `terminalPrompter` discovering there is no terminal —
    // it reports itself interactive and finds out only when asked, so a piped
    // `lanes link connect gmail` reaches this line having already opened a
    // browser and stored a credential. Failing there for want of a display name
    // would undo none of that. A label is worth having and never worth failing
    // a connect over; the account above it is the identity, and that one still
    // refuses rather than inventing a name.
    return suggestion;
  }
}
