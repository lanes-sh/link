import { loadConfigFile } from '#profile';
import { recordConfigChange } from '../../audit-change.ts';
import { ConfigDocument } from '../../config-edit.ts';
import { announce, announceProfile, heading, ok, print, style, table, warn } from '../../output.ts';
import { resolveProfile, resolveProfileOnly, type GlobalFlags } from '../../runtime.ts';
import { nextAfterEdit, publishProfileEdit } from '../../publish.ts';

/**
 * `lanes link policy` and `lanes link config show` — reading and editing what is granted.
 *
 * Both are control-plane operations under ADR-007: a policy change authorises
 * future agent behaviour, so it originates here and never over MCP.
 */

export async function policyList(flags: GlobalFlags): Promise<void> {
  const { selection, config } = await resolveProfileOnly(flags);
  announceProfile(selection);

  if (config.grants.length === 0) {
    print(style.dim('No grants. Default deny is in effect: nothing is reachable.'));
    return;
  }

  const expiry = (rule: { capability: string; expires_at?: string | undefined }) =>
    rule.expires_at ? style.dim(`until ${rule.expires_at}`) : '';

  // Grouped by connection rather than by effect, which reverses how this used to
  // read. A rule governs one account now (ADR-058), so "what may be done with
  // the work mailbox" is the question the listing should answer in one place —
  // and the old shape, two lists of capabilities with the account nowhere in
  // them, could not answer it at all.
  for (const grant of config.grants) {
    heading(grant.connection);

    if (grant.allow.length === 0 && grant.deny.length === 0) {
      print(style.dim('  Granted nothing. The connection is reachable and no capability is.'));
      continue;
    }

    table([
      ...grant.allow.map((rule) => [`  ${style.green('+')}`, rule.capability, expiry(rule)]),
      ...grant.deny.map((rule) => [`  ${style.red('-')}`, rule.capability, expiry(rule)]),
    ]);
  }

  print('');
  print(style.dim('A deny beats any allow on the same connection, whatever the order in the file.'));
  print(
    style.dim('A connection with no row above is not reachable at all, and is never advertised.'),
  );
}

export interface PolicyFlags extends GlobalFlags {
  readonly connection?: string | undefined;
}

/**
 * The data half. The wrapper below resolves the workspace from the process
 * environment, which is right for a terminal with one workspace in view; a
 * process serving many needs the half that takes an `env`.
 */
export async function applyPolicyRule(
  effect: 'allow' | 'deny',
  capability: string,
  flags: PolicyFlags,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<{ profile: string; capability: string; effect: 'allow' | 'deny' } | null> {
  const { resolution, config } = await resolveProfile(
    flags,
    options.env !== undefined ? { env: options.env } : {},
  );

  const key = flags.connection;
  if (key === undefined) throw new Error('--connection is required. A rule governs one connection (ADR-058).');

  const index = config.grants.findIndex((grant) => grant.connection === key);
  if (index === -1) {
    throw new Error(`Profile "${resolution.profile}" does not grant "${key}".`);
  }

  // Already declared is an outcome, not an error.
  if (config.grants[index]![effect].some((rule) => rule.capability === capability)) return null;

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.addTo(['grants', index, effect], capability, { inline: true });
  await document.save();

  return { profile: resolution.profile, capability, effect };
}

export async function policyRule(
  effect: 'allow' | 'deny',
  capability: string,
  flags: PolicyFlags,
): Promise<void> {
  const { resolution, config, target } = await resolveProfile(flags);

  // Required, and refused rather than guessed. A rule has to land in a row, and
  // with two mailboxes granted there is no answer to "which one" that is not a
  // guess about which account the operator meant to widen.
  const key = flags.connection;
  if (key === undefined) {
    throw new Error(
      `--connection is required. A rule governs one connection (ADR-058).\n` +
        (config.grants.length > 0
          ? `  This profile grants: ${config.grants.map((grant) => grant.connection).join(', ')}`
          : `  This profile grants nothing yet. Run: lanes link status --profile ${resolution.profile}`),
    );
  }

  const index = config.grants.findIndex((grant) => grant.connection === key);
  if (index === -1) {
    throw new Error(
      `Profile "${resolution.profile}" does not grant "${key}".\n` +
        `  Grant it first, then narrow it:\n` +
        `    lanes link grant ${key} --profile ${resolution.profile}`,
    );
  }

  const grant = config.grants[index]!;
  if (grant[effect].some((rule) => rule.capability === capability)) {
    print(style.dim(`${effect} ${capability} on ${key} is already declared.`));
    return;
  }

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);

  // A bare string, because that is what the file should read like. The object
  // form exists for `expires_at` and is not worth writing by default.
  document.addTo(['grants', index, effect], capability, { inline: true });
  // Validation runs before the write, so a rule naming a provider other than the
  // row's own fails here rather than matching nothing at runtime.
  await document.save();

  await recordConfigChange(
    config,
    resolution.workspaceRoot,
    target,
    {
      capability: effect === 'allow' ? 'config.policy.allow' : 'config.policy.deny',
      scope: resolution.profile,
      connection: key,
      arguments: { capability },
    },
    (note) => print(warn(note)),
  );

  announce(resolution);
  print(ok(`${effect} ${style.bold(capability)} on ${style.bold(key)}`));

  if (effect === 'deny' && grant.allow.some((rule) => rule.capability === '*')) {
    print(style.dim("  This narrows that row's catch-all allow; a deny always wins."));
  }

  // A deny the endpoint has not heard about is still granting what it names, so
  // a policy edit publishes itself exactly as connecting does (ADR-029).
  print(style.dim(`  ${nextAfterEdit(await publishProfileEdit({ resolution, config, target }))}`));
}

export async function configShow(flags: GlobalFlags): Promise<void> {
  const { selection } = await resolveProfileOnly(flags);
  announceProfile(selection);
  const { config } = await loadConfigFile(selection.profilePath);
  print(JSON.stringify(config, null, 2));
}
