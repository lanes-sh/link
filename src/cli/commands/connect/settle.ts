import { createMcpConnector } from '#connectivity/transports';
import { bearerTokenAsStored } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import type { Config } from '#profile';
import type { AnyConnector, ProviderManifest } from '#connectivity';
import { idFromAccount, resolveAccount } from '../../identity.ts';
import { style } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { accountSiblings } from './accounts.ts';

/**
 * Settle which connection this is, and whose account it belongs to.
 *
 * The order matters. An explicit `--id` wins, because someone who named it
 * meant it. Otherwise the provider is asked who authorised — and if an existing
 * connection already holds that account, we reuse *its* id, which is what turns
 * a re-run of `connect` into a repair rather than a duplicate. Only when
 * identity cannot be resolved at all do we ask.
 */
export async function settleIdentity(input: {
  manifest: ProviderManifest;
  provisionalId: string;
  explicitId: string | undefined;
  account: string | undefined;
  runtime: {
    config: Config;
    credentials: SecretStore;
    registry: { manifest(id: string): ProviderManifest | undefined };
    connectorFor(providerId: string, connectionId: string): AnyConnector | undefined;
  };
  prompter?: Prompter;
}): Promise<{ connectionId: string; account: string }> {
  const { manifest, provisionalId, explicitId, runtime } = input;
  const prompter = input.prompter ?? terminalPrompter;

  // Siblings across the whole vendor account, not just this provider — so
  // connecting iCloud Calendar after iCloud Mail lands on the same id, and
  // therefore the same credential, rather than a second `will2`.
  const siblings = accountSiblings(manifest, runtime.config, runtime.registry);

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

    account = await resolveAccount(manifest, {
      accessToken: token,
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

    account =
      (await prompter.ask(`Which account is this? ${style.dim('(label for this connection)')}`)) ||
      `${manifest.name} ${provisionalId}`;
  }

  if (explicitId) return { connectionId: explicitId, account };

  if (unaccounted) {
    return {
      connectionId: idFromAccount(
        'main',
        siblings.map((candidate) => candidate.id),
      ),
      account: account!,
    };
  }

  const already = siblings.find(
    (candidate) => candidate.account.toLowerCase() === account.toLowerCase(),
  );
  if (already) return { connectionId: already.id, account };

  return {
    connectionId: idFromAccount(
      account,
      siblings.map((candidate) => candidate.id),
    ),
    account,
  };
}
