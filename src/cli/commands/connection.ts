import { RESERVED_PROVIDER_IDS } from '#connectivity';
import { credentialRefFor } from '#registry';
import type { ConnectionConfig, Config, Resolution } from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, ok, print, style, warn } from '../output.ts';
import { openRuntime, type GlobalFlags } from '../runtime.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { confirm, isInteractive } from '../prompt.ts';

/**
 * `lanes link disconnect` and `lanes link relabel` — the two edits to an
 * existing connection that were not possible without opening the YAML.
 *
 * Both are control-plane commands under ADR-007: they write the profile config,
 * and `disconnect` also deletes from the target's credential store. Neither is
 * reachable through MCP, for the same reason `connect` is not.
 *
 * `disconnect` is the counterpart to `connect`, and deliberately not "delete":
 * the state record is left alone. Reconcile marks an undeclared connection
 * `disabled` rather than deleting it so the audit log keeps meaning something,
 * and a command that reached past that to erase the record would be undoing the
 * one guarantee the audit log offers.
 *
 * Each command is a data function plus a printing wrapper, the shape
 * `commands/identity.ts` uses: `--json` needs the facts without the rendering.
 */

/** Where a connection is, and what it says, before anything is changed. */
interface Located {
  readonly index: number;
  readonly connection: ConnectionConfig;
}

export interface Disconnected {
  readonly profile: string;
  readonly target: string;
  readonly key: string;
  readonly account: string;
  /**
   * The credential reference this removed, if it removed one. `null` when the
   * provider has none (the owner layer), when `--keep-credential` was passed, or
   * when a sibling connection still resolves to the same reference.
   */
  readonly credential: string | null;
  /** Set when the credential was left because something else still needs it. */
  readonly credentialSharedWith: readonly string[];
  readonly remaining: number;
  readonly published: string;
}

export interface Relabelled {
  readonly profile: string;
  readonly target: string;
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly published: string;
}

export interface DisconnectFlags extends GlobalFlags {
  readonly yes?: boolean | undefined;
  readonly keepCredential?: boolean | undefined;
  readonly json?: boolean | undefined;
}

export interface RelabelFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
}

/**
 * Find the one connection a key names.
 *
 * The key must be exact — `gmail.main`, never `gmail`. `connect` accepts the
 * bare provider because it can then create an account and choose the id; there
 * is nothing to choose here, and a bare `gmail` with two accounts declared would
 * be a command guessing which one to throw away.
 */
function locate(config: Config, key: string, profile: string): Located {
  if (!key.includes('.')) {
    const matches = config.connections.filter((one) => one.provider === key);
    throw new Error(
      `"${key}" names a provider, not a connection.\n` +
        (matches.length > 0
          ? `  This profile declares ${matches.map((one) => `${one.provider}.${one.id}`).join(', ')}.\n`
          : '') +
        `  Run: lanes link status --profile ${profile}`,
    );
  }

  const index = config.connections.findIndex((one) => `${one.provider}.${one.id}` === key);
  if (index === -1) {
    throw new Error(
      `Profile "${profile}" does not declare "${key}".\n` +
        `  Run: lanes link status --profile ${profile}`,
    );
  }

  return { index, connection: config.connections[index] as ConnectionConfig };
}

/**
 * Refuse for a reserved provider, and say what to do instead.
 *
 * `memory`, `skills`, `vault`, `setup` and `identity` are not accounts — they are
 * what the profile is *for*, they hold no credential, and each is granted by a
 * policy line this command does not touch. Removing the connection alone would
 * leave the policy granting `memory.*` against nothing: a config that is wrong
 * rather than merely untidy, which is the same reason `knowledge use` takes its
 * own block back. Hand-editing is the honest path and the file says so.
 */
function refuseReserved(key: string, provider: string, path: string): void {
  if (!RESERVED_PROVIDER_IDS.includes(provider)) return;
  throw new Error(
    `"${key}" is part of what this profile is, not an account it holds.\n` +
      `  ${provider} keeps no credential, and its policy grant is a separate line this command does not touch.\n` +
      `  To remove it, delete both from ${path} by hand.`,
  );
}

/**
 * Which other connections resolve to the same credential reference.
 *
 * The check exists because a reference is not always per connection. An OAuth
 * provider derives `<provider>/<id>` and is safe, but a manifest declaring
 * `credential_ref: mything/api_key` shares one reference across every connection
 * of that provider — so deleting it while a sibling still resolves to it would
 * take that sibling's credential with it, and the sibling would report
 * `unauthorized` for a `connect` nobody ran.
 */
export function connectionsSharingCredential(
  config: Config,
  ref: string,
  exceptIndex: number,
  manifestFor: (provider: string) => Parameters<typeof credentialRefFor>[1],
): string[] {
  return config.connections
    .filter((one, i) => i !== exceptIndex && credentialRefFor(one, manifestFor(one.provider)) === ref)
    .map((one) => `${one.provider}.${one.id}`);
}

/**
 * Take back the allow rules that named the provider, once nothing declares it.
 *
 * Not a tidy-up. `assertReferentialIntegrity` refuses an allow rule naming a
 * provider with no connection, and `save` validates — so disconnecting the last
 * connection of a provider *failed*, with a config error about a policy line the
 * operator had not touched, and nothing removed. Every single-account provider
 * was undisconnectable, which is most of them: the bug reproduced on `slack.*`
 * and would have on `bunq.*`, while a profile with two Gmail accounts could
 * disconnect one perfectly well.
 *
 * Symmetry is the argument for removing rather than warning. `connect` writes
 * the row *and* the rule, and the pair is what `config-repair.ts` calls both
 * halves or neither — a rule with nothing behind it grants nothing and is what
 * that file exists to stop being written.
 *
 * `allow: ['*']` is untouched: it names no provider, so nothing about it becomes
 * false. Narrower rules go with the wide one — `gmail.send_message` is as
 * dangling as `gmail.*` once the last Gmail is gone, and the loader refuses it
 * for the same reason.
 *
 * `deny` is left alone, deliberately. The loader permits a deny naming a
 * provider with no connection, because denying something you have not connected
 * yet is a reasonable thing to write ahead of time — and removing it here would
 * silently re-permit whatever it covered if the account came back.
 */
function dropProviderRules(document: ConfigDocument, config: Config, index: number): void {
  const going = config.connections[index];
  if (!going) return;

  const stillDeclared = config.connections.some(
    (one, i) => i !== index && one.provider === going.provider,
  );
  if (stillDeclared) return;

  const rules = document.getIn(['policy', 'allow']) as { items?: unknown[] } | null;
  const doomed: number[] = [];

  (rules?.items ?? []).forEach((_rule, at) => {
    const bare = document.getIn(['policy', 'allow', at]);
    const capability =
      typeof bare === 'string' ? bare : document.getIn(['policy', 'allow', at, 'capability']);
    if (typeof capability !== 'string') return;

    if (capability.split('.')[0] === going.provider) doomed.push(at);
  });

  // Descending, so each removal cannot move the index of one still to come.
  for (const at of doomed.reverse()) document.removeFrom(['policy', 'allow'], at);
}

export async function removeConnection(
  key: string,
  flags: DisconnectFlags,
): Promise<{ resolution: Resolution; disconnected: Disconnected } | null> {
  const runtime = await openRuntime(flags);

  try {
    const { resolution, config, target } = runtime;
    const located = locate(config, key, resolution.profile);
    const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);

    refuseReserved(key, located.connection.provider, document.path);

    if (!(await confirmed(key, flags))) return null;

    const manifestFor = (provider: string) => runtime.registry.get(provider)?.manifest;
    const ref = credentialRefFor(located.connection, manifestFor(located.connection.provider));
    const shared = ref ? connectionsSharingCredential(config, ref, located.index, manifestFor) : [];

    // The config edit first. If deleting the credential fails, a connection left
    // declared with no credential reports `unauthorized`, which is recoverable by
    // running `connect`. The reverse — credential gone, declaration kept, edit
    // failed — is the same state, so ordering costs nothing either way; doing the
    // edit first means the file is right even if the store is unreachable.
    // Both edits before the one `save`, so the file is never written in the
    // state where the row is gone and the rule that named it is not — which is
    // the state the loader refuses.
    dropProviderRules(document, config, located.index);
    document.removeFrom(['connections'], located.index);
    await document.save();

    let removed: string | null = null;
    if (ref && shared.length === 0 && flags.keepCredential !== true) {
      await runtime.credentials.delete(ref);
      removed = ref;
    }

    return {
      resolution,
      disconnected: {
        profile: resolution.profile,
        target,
        key,
        account: located.connection.account,
        credential: removed,
        credentialSharedWith: shared,
        remaining: config.connections.length - 1,
        published: nextAfterEdit(await publishProfileEdit({ resolution, config, target })),
      },
    };
  } finally {
    await runtime.close();
  }
}

/** A plain y/N. Not `profile remove`'s type-the-name, which guards the
 *  destruction of whole stores; this takes back one authorisation that `connect`
 *  can grant again. */
async function confirmed(key: string, flags: DisconnectFlags): Promise<boolean> {
  if (flags.yes === true) return true;
  if (!isInteractive()) {
    throw new Error(
      `Disconnecting "${key}" deletes its credential, and stdin is not a terminal, so there is nobody to ask.\n` +
        `  Pass --yes to proceed.`,
    );
  }
  // Defaults to no: this deletes a credential, and a stray return should not.
  return confirm(`Disconnect ${key} and delete its credential?`, false);
}

export async function disconnect(key: string | undefined, flags: DisconnectFlags): Promise<void> {
  if (!key) throw new Error('Which connection? Run: lanes link status');

  const outcome = await removeConnection(key, flags);
  if (outcome === null) {
    print(warn('nothing was changed'));
    return;
  }
  const { resolution, disconnected: result } = outcome;

  return emit(flags.json, result, () => {
    announce(resolution);
    print(ok(`disconnected ${style.bold(result.key)}${result.account ? ` (${result.account})` : ''}`));

    if (result.credential) {
      print(`      credential  ${style.dim(result.credential)} deleted`);
    } else if (result.credentialSharedWith.length > 0) {
      // Named rather than silent: the operator asked for a credential to go and
      // it did not, and the reason is a fact about their config.
      print(
        `      credential  kept — ${result.credentialSharedWith.join(', ')} still ${
          result.credentialSharedWith.length === 1 ? 'resolves' : 'resolve'
        } to it`,
      );
    }

    print(style.dim(`      ${result.remaining} connection(s) left in this profile.`));
    // The state record survives on purpose, and the next reconcile is what marks
    // it disabled. Saying so stops "it is still in `status`" reading as a failure.
    print(
      style.dim(
        '      The state record stays until the next reconcile, which marks it disabled rather than deleting it.',
      ),
    );
    if (result.published) print(style.dim(`      ${result.published}`));
  })
}

export async function renameConnection(
  key: string,
  account: string,
  flags: RelabelFlags,
): Promise<{ resolution: Resolution; relabelled: Relabelled }> {
  const runtime = await openRuntime(flags);

  try {
    const { resolution, config, target } = runtime;
    const located = locate(config, key, resolution.profile);
    const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);

    document.setIn(['connections', located.index, 'account'], account);
    await document.save();

    return {
      resolution,
      relabelled: {
        profile: resolution.profile,
        target,
        key,
        from: located.connection.account,
        to: account,
        published: nextAfterEdit(await publishProfileEdit({ resolution, config, target })),
      },
    };
  } finally {
    await runtime.close();
  }
}

export async function relabel(
  key: string | undefined,
  account: string | undefined,
  flags: RelabelFlags,
): Promise<void> {
  if (!key) throw new Error('Which connection? Run: lanes link status');
  if (!account) throw new Error(`What should ${key} be called? Run: lanes link relabel ${key} "New name"`);

  const { resolution, relabelled: result } = await renameConnection(key, account, flags);

  return emit(flags.json, result, () => {
    announce(resolution);
    print(ok(`${style.bold(result.key)} is now ${style.bold(result.to)}`));
    if (result.from) print(`      was     ${style.dim(result.from)}`);
    // The label is a display name in two places, and only one of them changed.
    print(
      style.dim(
        '      The state store keeps the old name until the next reconcile, which updates it.',
      ),
    );
    if (result.published) print(style.dim(`      ${result.published}`));
  })
}
