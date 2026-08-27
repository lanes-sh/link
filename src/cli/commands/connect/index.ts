import { credentialRefForConnection, WRITE_BUNDLE } from '#connectivity';
import { ConfigDocument } from '../../config-edit.ts';
import { ensureSetupConnection, repaired } from '../../config-repair.ts';
import { emit, print } from '../../output.ts';
import { nonInteractivePrompter, terminalPrompter, type Prompter } from '../../prompt.ts';
import { openRuntime, type GlobalFlags } from '../../runtime.ts';
import { moveCredential, siblingAccountId } from './accounts.ts';
import { grantProvider } from './grant.ts';
import { discoverCapabilities } from './discover.ts';
import { connectFamily, familyMembers } from './family.ts';
import { authoriseWithKey } from './assertion.ts';
import { authorise } from './authorise.ts';
import { authorisePastedToken } from './pasted-token.ts';
import { chooseAuthMethod } from './method.ts';
import { preflight } from './requirements.ts';
import { ALREADY, NOTHING, renderOutcome, where, type ConnectOutcome } from './outcome.ts';
import { nextAfterEdit, publishRuntimeEdit } from '#cli/publish.ts';
import { ensureStaticCredential } from './setup.ts';
import { settleIdentity } from './settle.ts';
import { runStrategySetup } from './strategy.ts';
import { announceConnectTarget } from './target-note.ts';
import { unknownProvider } from './unknown.ts';

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
  /**
   * `--own-client`, the older spelling of one of the routes `--auth` now names.
   *
   * Kept because it is in scripts and in a year of documentation, and because
   * it still says something true. It resolves to `--auth own_client`.
   */
  readonly ownClient?: boolean | undefined;
  /**
   * `--auth <method>`: which way in, for a provider that offers more than one.
   *
   * Unset means ask, where there is somebody to ask and something to ask
   * about. It is not sticky the way `--own-client` is: `--own-client` writes an
   * `oauth_apps` entry that every connection of the vendor then reads, whereas
   * this decides one connection's credential and is recorded by that credential
   * existing. Two accounts on the same profile may honestly differ.
   */
  readonly auth?: string | undefined;
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

export async function connect(target: string, options: ConnectOptions): Promise<void> {
  const outcome = await runConnect(target, options);

  if (!outcome.ok) process.exitCode = 1;

  return emit(options.json, outcome, () => renderOutcome(outcome));
}

/**
 * Exported for `connect custom`, which declares a provider and then connects it.
 *
 * Narrow on purpose — no extra parameters, no second entry point into the five
 * steps. The manifest is written before this is called, because the registry
 * that reads `providers.d/` is built by `openRuntime` on the first line.
 */
export async function runConnect(
  target: string,
  options: ConnectOptions,
  /** A family member — the account this belongs to has already said where it goes. */
  announced = false,
): Promise<ConnectOutcome> {
  const separator = target.indexOf('.');
  const providerId = separator === -1 ? target : target.slice(0, separator);
  const namedId = separator === -1 ? undefined : target.slice(separator + 1);

  // The runtime is opened first because its registry includes workspace
  // manifests — a custom provider must be as connectable as a built-in.
  const runtime = await openRuntime(options);

  try {
    // After the runtime rather than before, like every other command that
    // announces: the alternative is resolving the profile twice, which for a
    // `gs://` workspace is a second network read of the same YAML. Still long
    // before the browser opens, which is the part that matters. Inside the
    // `try` so the `finally` closes the runtime if the rendering throws.
    if (!announced) announceConnectTarget(runtime, options.json);

    const registry = runtime.registry;
    const entry = registry.get(providerId);

    // One name, several providers. `family.ts` says why iCloud is three.
    if (!entry) {
      const members = familyMembers(registry, providerId);

      if (members.length > 1) {
        await runtime.close();
        return connectFamily({
          name: providerId,
          members,
          options,
          namedId,
          connect: runConnect,
        });
      }
    }

    if (!entry) {
      throw unknownProvider({
        providerId,
        registry,
        workspaceRoot: runtime.resolution.workspaceRoot,
        profile: runtime.resolution.profile,
        target: runtime.target,
      });
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

    const prompter: Prompter =
      options.nonInteractive === true
        ? nonInteractivePrompter(`lanes link setup plan ${providerId} --profile ${profile}`)
        : terminalPrompter;

    // 0a. Which way in, before anything is resolved or written.
    //
    //     Ahead of the preflight because it changes the answer: one route needs
    //     a browser and the other needs a key, and refusing a scripted run for
    //     want of a browser it was never going to open is a refusal about the
    //     wrong thing. Inert for every provider declaring one method, which is
    //     all of them but one vendor's.
    const method = await chooseAuthMethod({
      manifest,
      requested: options.auth,
      ownClient: options.ownClient === true,
      prompter,
    });

    // 0b. With nobody to ask, resolve everything up front or refuse saying why.
    //
    //    Before any write, so a refusal leaves the profile exactly as it was.
    //    The whole list comes back at once: discovering a missing value a
    //    prompt at a time would cost an agent one round trip per secret.
    if (options.nonInteractive === true) {
      const blocked = await preflight({
        manifest,
        connectionId: named ?? adopted,
        profile,
        target: runtime.target,
        credentials: runtime.credentials,
        spec: target,
        method: method.kind,
      });

      if (blocked) return { ...NOTHING, ok: false, ...blocked };
    }

    if (method.kind === 'assertion') {
      await authoriseWithKey({
        manifest,
        assertion: method.assertion,
        connectionId: provisionalId,
        credentials: runtime.credentials,
        changes,
        // Same reading as the static-credential arm below: naming a connection,
        // or asking outright, is how someone says "that one again" — which is
        // what a rotated key calls for.
        replace: options.nonInteractive !== true && (options.replace === true || named !== undefined),
        prompter,
      });
    } else if (method.kind === 'pasted') {
      await authorisePastedToken({
        manifest,
        connectionId: provisionalId,
        credentials: runtime.credentials,
        prompter,
      });
    } else if (manifest.auth.kind === 'oauth') {
      await authorise({
        manifest,
        connectionId: provisionalId,
        credentials: runtime.credentials,
        document,
        changes,
        firstForProvider: !runtime.config.connections.some((c) => c.provider === providerId),
        target,
        profile,
        client: method.client,
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

    // 1b. The vendor's own handshake — see `./strategy.ts`, including why here.
    await runStrategySetup(manifest, provisionalId, runtime);

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

    // 3. Ask the upstream what it exposes.
    const discovered = await discoverCapabilities({
      entry,
      manifest,
      connectionId,
      credentials: runtime.credentials,
      connectorFor: runtime.connectorFor.bind(runtime),
      remember: async (found) => {
        await runtime.state.kv.set('discovery', providerId, JSON.stringify(found));
        registry.setDiscovered(providerId, found);
      },
    });

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
      // Named where the provider offered a choice, because this is the line an
      // operator reads to see that a re-connect swapped the route rather than
      // refreshed it — and `--auth` reaches here having asked nothing. Unnamed
      // for a provider with one way in, whose output is unchanged.
      changes.push(`re-authorised ${connectionKey}${method.id ? ` with ${method.id}` : ''}`);
    }

    // 5. Grant it — one rule per provider; `grant.ts` says why not per capability.
    const granted = grantProvider(document, runtime.config.policy.allow, providerId);

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
        ...where(runtime),
        discovered: discovered.length,
        next: ALREADY,
      };
    }

    await document.save();

    // Where the endpoint that has to serve this reads its config, and then a
    // nudge to re-read it. Neither is a deploy (ADR-029).
    const publish = await publishRuntimeEdit(runtime);

    return {
      ok: true,
      key: connectionKey,
      account,
      ...where(runtime),
      changes,
      granted,
      ...(notes.length > 0 ? { notes } : {}),
      discovered: discovered.length,
      writable: discovered.filter((c) => c.bundle === WRITE_BUNDLE).length,
      next: nextAfterEdit(publish),
    };
  } finally {
    await runtime.close();
  }
}
