import { createMcpConnector } from '#connectivity/transports';
import type { DiscoveredCapability } from '#connectivity';
import { credentialRefForConnection, WRITE_BUNDLE } from '#connectivity';
import { ConfigDocument, ensureSetupConnection, repaired } from '../../config-edit.ts';
import { emit, print, progress, style } from '../../output.ts';
import { nonInteractivePrompter, terminalPrompter, type Prompter } from '../../prompt.ts';
import { openRuntime, type GlobalFlags } from '../../runtime.ts';
import { credentialApp, matchesRule, moveCredential, siblingAccountId } from './accounts.ts';
import { authorise, oauthProviderFor } from './authorise.ts';
import { preflight } from './requirements.ts';
import { ALREADY, NOTHING, nextAfterConnect, renderOutcome, type ConnectOutcome } from './outcome.ts';
import { ensureStaticCredential } from './setup.ts';
import { settleIdentity } from './settle.ts';

/**
 * `lanes link connect <provider>` — the one command that adds an account.
 *
 * The same command regardless of connectivity. A local provider declares a
 * connection and stops; an MCP provider authorises, asks the upstream server
 * what it exposes, and grants it. Core learns nothing about any vendor: the
 * manifest says how to reach them and what to ask the operator for.
 *
 * The five numbered steps below are the whole command, and each one that grew
 * past a paragraph moved out: `authorise.ts` gets the token, `setup.ts` asks the
 * operator for what the vendor's console produced, `settle.ts` works out whose
 * account it was, and `accounts.ts` knows which connections are siblings.
 */

export interface ConnectOptions extends GlobalFlags {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  /** Ask for the stored credential again — a key rotated, or a password revoked. */
  readonly replace?: boolean | undefined;
  /**
   * Answer nothing from a terminal: resolve every declared value from the
   * credential store, and refuse with instructions where one is missing.
   */
  readonly nonInteractive?: boolean | undefined;
  /** The operator has already agreed to scopes broader than the provider needs. */
  readonly acceptBroadScopes?: boolean | undefined;
  /**
   * Register an OAuth client of your own rather than using a hosted one.
   *
   * Sticky by consequence rather than by flag: it writes the `oauth_apps` entry,
   * and a profile that declares one is never moved off it. So this is typed once
   * and then forgotten, which is the right shape for a decision about a client
   * that is shared by every connection of that vendor.
   */
  readonly ownClient?: boolean | undefined;
  /** Injected for tests. The broker is the only thing `connect` fetches. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly json?: boolean | undefined;
}


/**
 * The connection id used before the provider has said whose account this is.
 *
 * It is a placeholder rather than a name, and `setup.ts` reads it as one: a
 * credential filed under it belongs to a `connect` that did not finish.
 */
const PROVISIONAL_ID = 'pending';

/**
 * What discovery is actually doing, per kind, so the wait is explained.
 *
 * They differ enough to be worth saying: reading a local OpenAPI file is
 * instant, while signing in to an IMAP server is a TLS handshake and a LOGIN
 * against a host that sometimes takes its time.
 */
const DISCOVERY_NOTE: Record<string, string> = {
  mcp: 'Discovering capabilities…',
  http: 'Reading the API description…',
};

export async function connect(target: string, options: ConnectOptions): Promise<void> {
  const outcome = await runConnect(target, options);

  if (!outcome.ok) process.exitCode = 1;

  return emit(options.json, outcome, () => renderOutcome(outcome));
}

async function runConnect(target: string, options: ConnectOptions): Promise<ConnectOutcome> {
  const separator = target.indexOf('.');
  const providerId = separator === -1 ? target : target.slice(0, separator);
  const namedId = separator === -1 ? undefined : target.slice(separator + 1);

  // The runtime is opened first because its registry includes workspace
  // manifests — a custom provider must be as connectable as a built-in.
  const runtime = await openRuntime(options);

  try {
    const registry = runtime.registry;
    const entry = registry.get(providerId);

    // `lanes link connect icloud` — an account rather than a provider.
    //
    // Everyone models iCloud this way: Apple's own Settings, macOS Internet
    // Accounts, Thunderbird, DAVx⁵. One authorisation, three services. It is
    // three *providers* underneath because mail and calendars are different
    // protocols, and because a policy line per provider is what lets someone
    // allow `icloud_calendar.*` while never granting mail — but nobody should
    // have to know that to connect their account.
    if (!entry) {
      const family = registry
        .list()
        .filter((candidate) => credentialApp(candidate.manifest) === providerId)
        .map((candidate) => candidate.manifest.id);

      if (family.length > 1) {
        await runtime.close();
        progress(
          style.dim(`${providerId} is ${family.length} services on one account: ${family.join(', ')}`),
        );
        // In sequence, and the order matters: the first settles the account id
        // and stores the credential, and the rest find both already there.
        //
        // The id travels as a flag because the family members are addressed by
        // their own names: `connect icloud.will` parses `will` off a target
        // that is then thrown away, and recursing with `options` alone dropped
        // it — the command named an account and each member silently invented
        // its own.
        const inherited = { ...options, id: options.id ?? namedId };
        const members: ConnectOutcome[] = [];
        for (const member of family) members.push(await runConnect(member, inherited));

        // The whole account succeeded only if every service did. A partial
        // result is the case worth surfacing: one member blocked on a value
        // leaves an account half connected, which `status` shows and prose does
        // not.
        return {
          ...NOTHING,
          ok: members.every((outcome) => outcome.ok),
          members,
          ...(members.find((outcome) => !outcome.ok)?.reason
            ? { reason: members.find((outcome) => !outcome.ok)!.reason }
            : {}),
        };
      }
    }

    if (!entry) {
      const available = registry.list();
      const builtin = available.filter((c) => c.origin === 'builtin').map((c) => c.manifest.id);
      const custom = available.filter((c) => c.origin === 'workspace').map((c) => c.manifest.id);

      throw new Error(
        `Unknown provider "${providerId}".\n` +
          `  built in: ${builtin.join(', ')}\n` +
          (custom.length > 0
            ? `  yours:    ${custom.join(', ')}\n`
            : `  add your own: a manifest in ${runtime.resolution.workspaceRoot}/providers/\n`),
      );
    }

    const manifest = entry.manifest;
    const document = await ConfigDocument.open(runtime.resolution.workspaceRoot, runtime.resolution.profile);
    const changes: string[] = [];

    // 1. Authorise, if this provider needs it.
    //
    //    Under a provisional id, because the credential has to land somewhere
    //    before we can ask the provider whose account it is. The real id is
    //    settled below and the credential moves with it.
    //
    //    Unless a sibling already knows: when several providers of one vendor
    //    share a per-account credential, the second one should adopt the first's
    //    id rather than invent `pending` and ask for a password already held.
    const adopted = siblingAccountId(manifest, runtime.config, registry);
    const named = options.id ?? namedId;
    const provisionalId = named ?? adopted ?? PROVISIONAL_ID;

    const profile = runtime.resolution.profile;

    // 0. With nobody to ask, resolve everything up front or refuse saying why.
    //
    //    Before any write, so a refusal leaves the profile exactly as it was.
    //    The whole list comes back at once: discovering a missing value a
    //    prompt at a time would cost an agent one round trip per secret.
    if (options.nonInteractive === true) {
      const blocked = await preflight({
        manifest,
        connectionId: named ?? adopted,
        profile,
        credentials: runtime.credentials,
        target,
      });

      if (blocked) return { ...NOTHING, ok: false, ...blocked };
    }

    const prompter: Prompter =
      options.nonInteractive === true
        ? nonInteractivePrompter(`lanes link setup plan ${providerId} --profile ${profile}`)
        : terminalPrompter;

    if (manifest.auth.kind === 'oauth') {
      await authorise({
        manifest,
        connectionId: provisionalId,
        credentials: runtime.credentials,
        document,
        changes,
        firstForProvider: !runtime.config.connections.some((c) => c.provider === providerId),
        target,
        profile,
        ownClient: options.ownClient === true,
        prompter,
        acceptBroadScopes: options.acceptBroadScopes === true,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    } else if (manifest.auth.kind !== 'none') {
      await ensureStaticCredential({
        manifest,
        connectionId: provisionalId,
        credentials: runtime.credentials,
        // Naming a connection is how someone says "this one, again" — which is
        // what a rotated key or a revoked app-specific password calls for.
        // `--replace` says the same thing about a family, where there is no
        // single provider to name and the ids are not the operator's to know.
        //
        // Never non-interactively: there, "again" already happened. The new
        // value was written with `secrets set` before this ran, so asking would
        // be asking for something the store already holds.
        replace: options.nonInteractive !== true && (options.replace === true || named !== undefined),
        provisional: provisionalId === PROVISIONAL_ID,
        prompter,
      });
    }

    // 2. Ask the provider whose account that was.
    //
    //    This is what distinguishes reconnecting an existing account from
    //    adding a new one. Without it, a retried connect appends a second row
    //    rather than repairing the first — which is how `main2` and `main3`
    //    ended up in a config describing two mailboxes.
    const { connectionId, account } = await settleIdentity({
      manifest,
      provisionalId,
      explicitId: named,
      account: options.displayName,
      runtime,
      prompter,
    });

    const connectionKey = `${providerId}.${connectionId}`;

    if (connectionId !== provisionalId) {
      // Wherever the manifest puts it — which is not always `<provider>/<id>`,
      // and is a no-op when the manifest names one credential shared by every
      // account.
      const from = credentialRefForConnection(manifest, provisionalId);
      const to = credentialRefForConnection(manifest, connectionId);
      if (from && to && from !== to) await moveCredential(runtime.credentials, from, to);
    }

    // 3. Ask the upstream what it exposes. A manifest never declares
    //    capabilities for a proxied server — the server is the source of truth,
    //    and a declared list would go stale the moment the vendor ships.
    let discovered: DiscoveredCapability[] = [];

    if (manifest.connector.kind !== 'local') {
      progress(style.dim(DISCOVERY_NOTE[manifest.connector.kind] ?? 'Discovering capabilities…'));

      // MCP is the one kind that does not use the runtime's connector here: it
      // wants the token exactly as just written, without the refresh machinery
      // that `resolveUpstreamToken` wraps around it. Every other kind carries
      // whatever credential it needs from the factory.
      const connector =
        manifest.connector.kind === 'mcp'
          ? createMcpConnector({
              endpoint: manifest.connector.endpoint,
              accessToken: async () => {
                const provider = oauthProviderFor(manifest, connectionId, runtime.credentials);
                const tokens = (await provider.tokens()) as { access_token?: string } | undefined;
                return tokens?.access_token ?? null;
              },
            })
          : runtime.connectorFor(providerId, connectionId);

      if (connector) {
        // Discovery takes the manifest and nothing else. What a provider exposes
        // is a property of the provider, not of an account — which is just as
        // well, because the connection being created does not exist in config
        // until step 4 below.
        discovered = await connector.discover({ manifest });

        await runtime.state.kv.set('discovery', providerId, JSON.stringify(discovered));
        registry.setDiscovered(providerId, discovered);
      }
    } else if (entry.definition) {
      // Local capabilities carry their bundle from the manifest. Resources are
      // included alongside tools: they need a policy grant too, and leaving
      // them out would register a resource nothing is allowed to read.
      const bundleOf = (name: string): string | undefined =>
        manifest.bundles?.find((candidate) => candidate.capabilities.includes(name))?.name;

      discovered = entry.definition.capabilities.map((capability) => ({
        name: capability.name,
        description: capability.description,
        inputSchema: {},
        ...(bundleOf(capability.name) ? { bundle: bundleOf(capability.name)! } : {}),
      }));
    }

    // 4. Declare the connection, or update the one this account already has.
    const existingIndex = runtime.config.connections.findIndex(
      (c) => `${c.provider}.${c.id}` === connectionKey,
    );

    if (existingIndex === -1) {
      // No `credential_ref`: it derives to `<provider>/<id>`, which is exactly
      // where the OAuth provider already looks. Writing it would add a line per
      // connection that can only ever agree or be a bug.
      document.addTo(['connections'], { id: connectionId, provider: providerId, account });
      changes.push(`connections += ${connectionKey} (${account})`);
    } else {
      // A reconnect. The credential was just replaced above; the declaration
      // stays as it is, so re-running connect after an expiry is a no-op on the
      // file rather than a second row.
      if (runtime.config.connections[existingIndex]?.account !== account) {
        document.setIn(['connections', existingIndex, 'account'], account);
        changes.push(`connections.${connectionKey}.account = ${account}`);
      }
      changes.push(`re-authorised ${connectionKey}`);
    }

    // 5. Grant it.
    //
    //    One rule per provider, not one per capability. The pinned-per-tool
    //    form this replaced was 85 lines for four providers and unreadable, and
    //    what it bought — a vendor cannot widen your policy by shipping a new
    //    tool — is preserved instead by `doctor`, which reports capabilities
    //    that appeared after you connected.
    const granted: string[] = [];
    const rule = `${providerId}.*`;

    if (!runtime.config.policy.allow.some((existing) => matchesRule(existing.capability, rule))) {
      document.addTo(['policy', 'allow'], rule, { inline: true });
      granted.push(rule);
    }

    // 6. Repair the setup surface if this profile predates it.
    //
    //    Connecting is the moment it matters: the operator is adding something
    //    an agent will be asked about, and a profile with no `setup` row serves
    //    no `setup_overview` — so the agent has nothing to read and invents a
    //    command instead. `doctor` reports this, but a deployed operator never
    //    runs it, which is how it stayed broken.
    //    Each half goes to the field that is for it. `emit` serialises both
    //    verbatim under `--json`: `changes` is a list of config edits, so a
    //    sentence in it is something a caller counting edits has to recognise
    //    and skip, and `granted` is the field that answers "what did this widen"
    //    — an audit reading it would have missed `setup.*` entirely.
    const repair = ensureSetupConnection(document);
    changes.push(...repair.changes);
    granted.push(...repair.granted);

    // The explanation is prose, so it goes where prose goes. Without it the
    // operator has two lines naming a provider they never asked for.
    const notes = repaired(repair)
      ? ['that is the setup surface — it lets an agent see what is connected here']
      : [];

    if (changes.length === 0 && granted.length === 0) {
      return {
        ...NOTHING,
        ok: true,
        key: connectionKey,
        account,
        discovered: discovered.length,
        next: ALREADY,
      };
    }

    await document.save();

    return {
      ok: true,
      key: connectionKey,
      account,
      changes,
      granted,
      ...(notes.length > 0 ? { notes } : {}),
      discovered: discovered.length,
      writable: discovered.filter((c) => c.bundle === WRITE_BUNDLE).length,
      // A running endpoint reads its config once, at startup. Saying "start"
      // to someone who already has one running reads as "you are done", and
      // they then ask an agent that cannot see the connection yet. Which
      // endpoint to say depends on the target: a deployment is replaced by
      // `deploy`, not restarted by hand.
      next: nextAfterConnect(runtime.config.targets[runtime.target]?.deploy !== undefined),
    };
  } finally {
    await runtime.close();
  }
}
