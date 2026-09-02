import { CONNECTIONS_FILE } from '#profile';
import { credentialRefForConnection, WRITE_BUNDLE } from '#connectivity';
import { recordConfigChange } from '../../audit-change.ts';
import { ConfigDocument } from '../../config-edit.ts';
import { ensureOwnerLayer, repaired } from '../../config-repair.ts';
import { emit, print } from '../../output.ts';
import { nonInteractivePrompter, terminalPrompter, type Prompter } from '../../prompt.ts';
import type { ConnectOptions } from './options.ts';

export type { ConnectOptions } from './options.ts';
import {
  grantedConnections,
  openRuntime,
  primaryProfile,
  type GlobalFlags,
} from '../../runtime.ts';
import { moveCredential, siblingAccountId } from './accounts.ts';
import { grantConnection } from './grant.ts';
import { acquireCredential } from './acquire.ts';
import { declareConnection } from './declare.ts';
import { resolveConnectionAddress, type ResolvedAddress } from './variables.ts';
import { discoverCapabilities } from './discover.ts';
import { connectFamily, familyMembers } from './family.ts';
import { authoriseWithKey } from './assertion.ts';
import { authorise } from './authorise.ts';
import { authorisePastedToken } from './pasted-token.ts';
import { chooseAuthMethod } from './method.ts';
import { preflight } from './requirements.ts';
import { parseSet } from './variables.ts';
import { ALREADY, NOTHING, renderOutcome, where, type ConnectOutcome } from './outcome.ts';
import { nextAfterEdit, publishRuntimeEdit } from '#cli/publish.ts';
import { bindNewCredential } from './bind-credential.ts';
import { ensureStaticCredential } from './setup.ts';
import { settleIdentity } from './settle.ts';
import { runStrategySetup } from './strategy.ts';
import { announceConnectTarget } from './target-note.ts';
import { unknownProvider } from './unknown.ts';
import { DISCOVERY_NAMESPACE } from '#stores/state';

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
  // A connection belongs to the workspace, so connecting does not need a
  // profile (ADR-057). One is still resolved, because the registry that reads
  // `providers.d/` is opened through a runtime and a runtime carries one — but
  // it is not the subject, and nothing is written to it unless `--profile` was
  // actually given.
  const granting = options.profile !== undefined;
  const runtime = await openRuntime({ ...options, profile: await primaryProfile(options) });

  // Declared out here so the `finally` can close whatever it built.
  let address: ResolvedAddress | undefined;

  try {
    // After the runtime rather than before, like every other command that
    // announces: the alternative is resolving the profile twice, which for a
    // `gs://` workspace is a second network read of the same YAML. Still long
    // before the browser opens, which is the part that matters. Inside the
    // `try` so the `finally` closes the runtime if the rendering throws.
    if (!announced) announceConnectTarget(runtime, options.json, granting);

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
    // Two documents, because a connection and a grant live in two files
    // (ADR-057). Both opened here, so a failure to open either happens before
    // anything is written to the other.
    const document = await ConfigDocument.open(
      runtime.resolution.workspaceRoot,
      runtime.resolution.profile,
    );
    const connectionsDocument = await ConfigDocument.openKey(
      runtime.resolution.workspaceRoot,
      CONNECTIONS_FILE,
    );
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
    const adopted = siblingAccountId(manifest, runtime.workspaceConnections, registry);
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
        supplied: parseSet(options.set),
      });

      if (blocked) return { ...NOTHING, ok: false, ...blocked };
    }

    // 1a. Where this connection's service is, for a provider whose address is
    //     not the same for everybody.
    //
    //     First, and before anything is written: step 0b's rule is that a
    //     refusal leaves the profile as it was, and asked last a non-interactive
    //     run with no `--set` acquired a credential before refusing.
    address = await resolveConnectionAddress({
      manifest,
      prompter,
      runtime,
      providerId,
      provisionalId,
      interactive: options.nonInteractive !== true,
      set: options.set,
    });

    // 1b. Get the credential, whichever of the four ways this provider offers.
    //     See `./acquire.ts` — the arms each live in their own module already,
    //     and that file is the choosing.
    await acquireCredential({
      method,
      manifest,
      provisionalId,
      credentials: runtime.credentials,
      // The connections file, not the profile. `oauth_apps` moved there in
      // contract 3 — `configSchema` does not declare it any more and only
      // `connectionsFileSchema` does — so `--own-client` was writing the switch
      // into a key nothing reads. With no `--profile` the profile document is
      // not even saved, so it was reported and discarded; with one, it landed in
      // a block the schema drops, and dispatch fell back to the broker client
      // while `deploy` bound none of the operator's own refs.
      document: connectionsDocument,
      changes,
      providerId,
      connections: grantedConnections(runtime),
      target,
      profile,
      prompter,
      named: named !== undefined,
      provisional: provisionalId === PROVISIONAL_ID,
      replace: options.replace === true,
      nonInteractive: options.nonInteractive === true,
      acceptBroadScopes: options.acceptBroadScopes === true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    // 1c. The vendor's own handshake — see `./strategy.ts`, including why here.
    await runStrategySetup(manifest, provisionalId, runtime);

    // 2. Ask the provider whose account that was.
    //
    //    This is what distinguishes reconnecting an existing account from
    //    adding a new one. Without it, a retried connect appends a second row
    //    rather than repairing the first — which is how `main2` and `main3`
    //    ended up in a config describing two mailboxes.
    const { connectionId, account, label } = await settleIdentity({
      manifest,
      provisionalId,
      explicitId: named,
      account: options.displayName,
      label: options.label,
      runtime: { ...runtime, connectorFor: address.connectorFor },
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
      connectorFor: address.connectorFor,
      remember: async (found) => {
        await runtime.state.kv.set(DISCOVERY_NAMESPACE, providerId, JSON.stringify(found));
        registry.setDiscovered(providerId, found);
      },
    });

    // 4. Declare the connection, or update the one this account already has.
    changes.push(
      ...declareConnection({
        document: connectionsDocument,
        connections: runtime.workspaceConnections,
        providerId,
        connectionId,
        account,
        label,
        method: method.id,
        config: address.values,
      }),
    );

    // 5. Grant it — one row naming the connection, carrying its provider's
    //    wildcard (ADR-058). The row *is* the grant, so neither half can be
    //    written without the other.
    //    Only when a profile was named. Connecting authorises an account into
    //    the workspace; deciding what may be done with it belongs to a profile,
    //    and those are two acts — so `connect` without `--profile` leaves the
    //    account granted to nobody and says how to grant it. Writing a grant
    //    into a profile the operator did not name would be choosing for them.
    const granted = granting
      ? grantConnection(document, runtime.config, `${providerId}.${connectionId}`)
      : [];

    // 6. Repair the owner layer if this profile predates it.
    //
    //    Connecting is the moment it matters: the operator is adding something
    //    an agent will be asked about, and a profile with no `setup` row serves
    //    no `setup_overview` — so the agent has nothing to read and invents a
    //    command instead. `doctor` reports this, but a deployed operator never
    //    runs it, which is how it stayed broken. The same argument now covers
    //    memory, tasks, assets, skills and the vault (ADR-050): a profile
    //    written before they were default has no rows for them, and none of them
    //    reaches an account, so there is nothing for the operator to decide.
    //    Each half goes to the field that is for it. `emit` serialises both
    //    verbatim under `--json`: `changes` is a list of config edits, so a
    //    sentence in it is something a caller counting edits has to recognise
    //    and skip, and `granted` is the field that answers "what did this widen"
    //    — an audit reading it would have missed `setup.*` entirely.
    const repair = ensureOwnerLayer(connectionsDocument, document, { grants: granting });
    changes.push(...repair.changes);
    granted.push(...repair.granted);

    // The explanation is prose, so it goes where prose goes. Without it the
    // operator has a block of lines naming providers they never asked for.
    const notes = repaired(repair)
      ? ['that is your own memory, tasks, assets, skills and vault — no account, nothing stored until you use them']
      : [];

    // 7. Bind the credential to the revision that serves it — `bind-credential.ts`.
    const bound = await bindNewCredential(runtime, providerId, connectionId, account);
    if (bound.failed) notes.push(bound.failed);
    if (changes.length === 0 && granted.length === 0) {
      return {
        ...NOTHING,
        ok: true,
        key: connectionKey,
        account,
        label,
        ...where(runtime),
        ...(notes.length > 0 ? { notes } : {}),
        discovered: discovered.length,
        next: ALREADY,
      };
    }

    // The connections file first, always, and the profile second.
    //
    // First because a grant naming a connection the workspace does not hold is
    // refused at load by `assertGrantsResolve` — so if only one of these two
    // writes lands, it has to be this one. The other order leaves a workspace
    // that will not open.
    //
    // Always because this is where the connection is *declared*, and until this
    // release it was never written at all: `declareConnection` edited a document
    // in memory and nothing saved it, so a connect stored the credential, wrote
    // the grant, and left no row. The account was authorised, invisible, and
    // unusable.
    await connectionsDocument.save();

    // Untouched when no profile was named, and `save()` on an unchanged document
    // still rewrites the file — which would restamp a profile nobody asked to
    // edit.
    if (granting) await document.save();

    // A connection belongs to the workspace, so the row is scoped to the
    // workspace even when a profile was granted it in the same breath — the
    // grant is its own event, written by `grant`.
    await recordConfigChange(
      runtime.config,
      runtime.resolution.workspaceRoot,
      runtime.target,
      {
        capability: 'config.connection.create',
        scope: runtime.target,
        connection: connectionKey,
        arguments: { account, ...(label ? { label } : {}) },
      },
    );

    // Where the endpoint that has to serve this reads its config, and then a
    // nudge to re-read it. Neither is a deploy (ADR-029).
    const publish = await publishRuntimeEdit(runtime);

    return {
      ok: true,
      key: connectionKey,
      account,
      label,
      ...where(runtime),
      changes,
      granted,
      ...(notes.length > 0 ? { notes } : {}),
      discovered: discovered.length,
      writable: discovered.filter((c) => c.bundle === WRITE_BUNDLE).length,
      next: nextAfterEdit(publish),
    };
  } finally {
    // Before the runtime, and separately: this one holds its own cache, so a
    // provider whose connector is a socket would otherwise keep it until exit.
    await address?.close();
    await runtime.close();
  }
}
