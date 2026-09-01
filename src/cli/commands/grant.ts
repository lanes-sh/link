import { ConfigError, connectionRefOf, readConnections, type Resolution } from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, ok, print, style } from '../output.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { resolveProfile, type GlobalFlags } from '../runtime.ts';

/**
 * `lanes link grant` and `lanes link revoke` — which of the workspace's accounts
 * a profile may reach.
 *
 * The command that did not need to exist under contract 2, because connecting an
 * account and granting it were the same act: `connect` wrote a row into the
 * profile and a rule beside it, and a second profile wanting the same mailbox
 * connected it again. A connection belongs to the workspace now (ADR-057), so
 * authorising an account and deciding who may use it are two commands — and
 * this is the second one.
 *
 * A grant row carries the provider wildcard, which is what `connect` writes for
 * the profile that made the connection. Narrowing it afterwards is
 * `lanes link policy deny <capability> --connection <ref>`; the two are separate
 * because widening and narrowing are different decisions and reading them in one
 * command's flags would hide which had happened.
 */

export interface Granted {
  readonly profile: string;
  readonly target: string;
  readonly connection: string;
  readonly account: string;
  readonly allowed: readonly string[];
  readonly published: string;
}

export async function grantConnectionTo(
  key: string | undefined,
  flags: GlobalFlags & { json?: boolean },
): Promise<void> {
  if (!key) {
    throw new ConfigError(
      'Which connection? Run: lanes link connection list\n' +
        '  e.g. lanes link grant gmail.personal --profile assistant',
    );
  }

  const { resolution, config, target } = await resolveProfile(flags);
  const root = resolution.workspaceRoot;

  const held = (await readConnections(root)).connections;
  const connection = held.find((one) => connectionRefOf(one) === key);

  // Refused rather than written on trust. A grant naming a connection the
  // workspace does not hold is refused at load by `assertGrantsResolve`, so
  // writing one would leave a profile that no longer opens — and the operator
  // would have been told "ok" by the command that broke it.
  if (connection === undefined) {
    throw new ConfigError(
      `This workspace holds no connection "${key}".\n` +
        (held.length > 0
          ? `  It holds: ${held.map(connectionRefOf).join(', ')}\n`
          : '  It holds none yet. Connect one with: lanes link connect <provider>\n') +
        `  Run "lanes link connection list --workspace ${target}" to see them.`,
    );
  }

  if (config.grants.some((grant) => grant.connection === key)) {
    print(style.dim(`${resolution.profile} already grants ${key}.`));
    return;
  }

  const rule = `${connection.provider}.*`;
  const document = await ConfigDocument.open(root, resolution.profile);
  document.addTo(['grants'], { connection: key, allow: [rule], deny: [] }, { inline: true });
  await document.save();

  const granted: Granted = {
    profile: resolution.profile,
    target,
    connection: key,
    account: connection.account,
    allowed: [rule],
    published: nextAfterEdit(await publishProfileEdit({ resolution, config, target })),
  };

  return emit(flags.json, granted, () => {
    announce(resolution);
    print(ok(`granted ${style.bold(key)} to ${style.bold(granted.profile)}`));
    print(`      account     ${style.dim(granted.account)}`);
    print(`      allowed     ${granted.allowed.join(', ')}`);
    print(
      style.dim(
        `      Narrow it with: lanes link policy deny <capability> --connection ${key} ` +
          `--profile ${granted.profile}`,
      ),
    );
    if (granted.published) print(style.dim(`      ${granted.published}`));
  });
}

/**
 * Take a grant back, leaving the account where it is.
 *
 * Not `disconnect`, and the difference is the whole reason both exist: this
 * removes one profile's permission and touches nothing else, while `disconnect`
 * removes the account from the workspace and every profile that named it.
 * Conflating them is how somebody loses a mailbox meaning to narrow an agent.
 */
export async function revokeConnectionFrom(
  key: string | undefined,
  flags: GlobalFlags & { json?: boolean },
): Promise<void> {
  if (!key) {
    throw new ConfigError(
      'Which connection? Run: lanes link policy list\n' +
        '  e.g. lanes link revoke gmail.personal --profile assistant',
    );
  }

  const { resolution, config, target } = await resolveProfile(flags);
  const at = config.grants.findIndex((grant) => grant.connection === key);

  if (at === -1) {
    print(style.dim(`${resolution.profile} does not grant ${key}.`));
    return;
  }

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.removeFrom(['grants'], at);
  await document.save();

  return emit(flags.json, { profile: resolution.profile, target, connection: key }, () => {
    announce(resolution);
    print(ok(`revoked ${style.bold(key)} from ${style.bold(resolution.profile)}`));
    print(
      style.dim(
        '      The account is untouched, and every other profile granting it still reaches it.\n' +
          `      To remove the account itself: lanes link disconnect ${key}`,
      ),
    );
  });
}
