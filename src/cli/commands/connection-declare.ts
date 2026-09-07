import { RESERVED_PROVIDER_IDS } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import {
  CONNECTIONS_FILE,
  ConfigError,
  connectionRefOf,
  defaultConnectionLabel,
  loadProfileConfig,
  readConnections,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, ok, print, style } from '../output.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { resolveProfile, type GlobalFlags } from '../runtime.ts';
import { declareConnection } from './connect/declare.ts';
import { grantConnection } from './connect/grant.ts';

/**
 * `lanes link connection declare` — name an account before authorising it.
 *
 * The command that makes a client's tool list stop moving (ADR-075).
 *
 * What a client is served is built from grant rows and never consults whether a
 * credential exists — `connectionsOf` in `#server/mcp` reads
 * `config.grants` and nothing else, because the grant row *is* the grant
 * (ADR-058). And a connection with no valid credential is already a first-class
 * state rather than a broken one: `reconcile` marks it `unauthorized` from
 * `credentials.has`, the status is documented as not blocking startup, and a
 * call against it is refused by the dispatcher with a sentence saying to connect
 * it.
 *
 * So the endpoint could always advertise an account that was not yet authorised.
 * There was simply no way to ask for one, because the only path to a connection
 * row went through `connect`, which acquires a credential first — and therefore
 * the advertised list changed at the moment of authorising, which is the moment
 * an operator is least able to also go and refresh a client.
 *
 * With this, the two events separate. Declare the accounts a profile will hold,
 * register the client against a list that already names them, then authorise
 * them whenever — `connect` fills in the credential and the list does not move.
 * A client that never re-reads its tool list, which is the whole problem issue
 * #162 is about, sees the right list the first time.
 *
 * **The account is asked for, and a later `connect` corrects it.** Identity is
 * normally resolved from the provider itself (ADR-073), and that needs the
 * credential this command is defined by not having. So the operator says who it
 * is, and it is provisional in a way nothing else here is: `declareConnection`'s
 * reconnect branch rewrites `account` when the provider reports something
 * different, so the first real `connect` repairs a guess. That is the reason
 * asking is acceptable rather than a regression against ADR-073 — the answer is
 * not load-bearing and does not survive being wrong.
 *
 * **Declaring is not granting**, the same way connecting is not (ADR-057). Only
 * `--profile` writes the grant row, and only the grant row changes what a client
 * sees — so a declare without one has done nothing for the tool list, and says
 * so rather than reporting success at the thing the operator came for.
 */

export interface Declared {
  readonly key: string;
  readonly provider: string;
  readonly account: string;
  readonly label: string;
  readonly target: string;
  /** The profile the grant went to, or `null` when none was named. */
  readonly profile: string | null;
  readonly allowed: readonly string[];
  readonly changes: readonly string[];
  readonly published: string;
}

export async function connectionDeclare(
  providerId: string | undefined,
  flags: GlobalFlags & {
    json?: boolean;
    id?: string | undefined;
    account?: string | undefined;
    label?: string | undefined;
  },
): Promise<void> {
  if (!providerId) {
    throw new ConfigError(
      'Which provider? Run: lanes link setup plan\n' +
        '  e.g. lanes link connection declare gmail --account ada.lovelace@example.com --profile assistant',
    );
  }

  // The owner layer is not connectable and not declarable — its instances are
  // written by `ensureOwnerLayer`, and a hand-written row for one would collide
  // with the repair rather than replace it.
  if (RESERVED_PROVIDER_IDS.includes(providerId)) {
    throw new ConfigError(
      `${providerId} is one of Lanes' own surfaces, not an account to declare.\n` +
        '  Every profile arrives holding it. Run: lanes link check',
    );
  }

  const manifest = PROVIDER_MANIFESTS.find((one) => one.id === providerId);
  if (manifest === undefined) {
    throw new ConfigError(
      `No provider "${providerId}".\n` +
        '  Run "lanes link setup plan" for the ones this build knows.',
    );
  }

  if (!flags.account) {
    throw new ConfigError(
      `Which account is this ${manifest.name} connection?\n` +
        '  Nothing can be asked of the provider until it is authorised, so say who it is:\n' +
        `    lanes link connection declare ${providerId} --account <address>\n` +
        '  A later `lanes link connect` corrects it if the provider reports something else.',
    );
  }

  const local = resolveWorkspaceRoot();
  const root = await resolveTargetWorkspace(local, flags.target ?? 'local');

  const connectionId = flags.id ?? 'main';
  const key = `${providerId}.${connectionId}`;

  const held = (await readConnections(root)).connections;
  if (held.some((one) => connectionRefOf(one) === key)) {
    throw new ConfigError(
      `This workspace already holds ${key}.\n` +
        `  To grant it to a profile:   lanes link grant ${key} --profile <name>\n` +
        `  To authorise it:            lanes link connect ${providerId} --id ${connectionId}\n` +
        `  To declare a second account: --id <another>`,
    );
  }

  const account = flags.account;
  const derived = defaultConnectionLabel(manifest.name, account);
  const label = flags.label ?? derived;

  const connectionsDocument = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
  const changes = [
    ...declareConnection({
      document: connectionsDocument,
      connections: held,
      providerId,
      connectionId,
      account,
      label,
      defaultLabel: derived,
      method: undefined,
      config: {},
    }),
  ];

  // The grant, and only where a profile was named — see the docstring. Resolved
  // rather than assumed, so naming a profile that does not exist fails here
  // instead of writing a connection row and then throwing.
  const granting = flags.profile !== undefined;
  let allowed: readonly string[] = [];
  let profileDocument: ConfigDocument | undefined;
  let resolved: Awaited<ReturnType<typeof resolveProfile>> | undefined;

  if (granting) {
    resolved = await resolveProfile(flags);
    profileDocument = await ConfigDocument.open(root, resolved.resolution.profile);
    allowed = grantConnection(profileDocument, resolved.config, key);
  }

  // Connections file first, always. A grant naming a connection the workspace
  // does not hold is refused at load by `assertGrantsResolve`, so if only one of
  // the two writes lands it has to be this one — the other order leaves a
  // workspace that will not open. Same rule, and same reason, as `connect`.
  await connectionsDocument.save();
  if (profileDocument) await profileDocument.save();

  const declared: Declared = {
    key,
    provider: providerId,
    account,
    label,
    target: flags.target ?? 'local',
    profile: resolved?.resolution.profile ?? null,
    allowed,
    changes,
    published:
      resolved === undefined
        ? ''
        : nextAfterEdit(
            await publishProfileEdit({
              resolution: resolved.resolution,
              config: (await loadProfileConfig(root, resolved.resolution.profile)).config,
              target: resolved.target,
            }),
          ),
  };

  return emit(flags.json, declared, () => {
    if (resolved) announce(resolved.resolution);
    print(ok(`declared ${style.bold(key)}`));
    print(`      account     ${style.dim(account)}`);
    print(`      label       ${style.dim(label)}`);

    if (declared.profile === null) {
      // Said plainly, because the operator ran this to make a tool list stable
      // and an ungranted connection changes no tool list at all.
      print(
        style.dim(
          '      Granted to nobody, so no client sees it yet. Grant it with:\n' +
            `        lanes link grant ${key} --profile <name>`,
        ),
      );
    } else {
      print(`      granted to  ${style.bold(declared.profile)}`);
      print(
        style.dim(
          `      Its tools are advertised now and refuse calls until it is authorised:\n` +
            `        lanes link connect ${providerId} --id ${connectionId} --profile ${declared.profile}`,
        ),
      );
    }

    if (declared.published) print(style.dim(`      ${declared.published}`));
  });
}
