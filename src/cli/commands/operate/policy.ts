import { RESERVED_PROVIDER_IDS } from '#connectivity/manifest/owner-ids.ts';
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
    config.instance.profile,
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

/**
 * `lanes link policy remove` — stop having an opinion about a capability.
 *
 * The policy family could add a rule in both directions and take away neither,
 * which made a deny a one-way door: `allow` is not its inverse and cannot be,
 * because a deny beats an allow on the same connection whatever the order in
 * the file. So the cheap, reversible-looking experiment — narrowing a surface
 * to see what breaks — was the one that could not be undone from the CLI. The
 * ways out were editing `profile.yaml` behind the tool's back, or `revoke` and
 * `grant` again, which resets every other rule on that connection on the way
 * past. It also left `policy` as the only family without a pair, beside
 * `grant`/`revoke`, `identity add`/`remove` and `members add`/`remove`.
 *
 * **Both signs go, and it is not told which.** "Remove the rule about this
 * capability" is what somebody means; asking `--allow` or `--deny` would make
 * the common case two flags and the uncommon case a question nobody has. What
 * is removed is printed, so a rule the caller had forgotten is reported rather
 * than silently dropped.
 *
 * **The match is literal.** `policy remove 'gmail.*'` removes the rule spelled
 * `gmail.*`, not the rules it would have matched. Removing by pattern would
 * make one command delete rules it never named, and on this surface that reads
 * as widening by accident.
 */
export async function policyRemove(capability: string, flags: PolicyFlags): Promise<void> {
  const { resolution, config, target } = await resolveProfile(flags);

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
        `  Nothing on it to remove. Its grants: ` +
        `${config.grants.map((grant) => grant.connection).join(', ') || 'none'}`,
    );
  }

  const grant = config.grants[index]!;
  const effects = (['allow', 'deny'] as const)
    .map((effect) => ({
      effect,
      at: grant[effect].findIndex((rule) => rule.capability === capability),
    }))
    .filter((found) => found.at !== -1);

  // Refused with the row's rules rather than reported as a no-op. A removal
  // that prints nothing and exits zero is indistinguishable from one that
  // worked, and the capability is usually mistyped rather than absent.
  if (effects.length === 0) {
    const rules = [
      ...grant.allow.map((rule) => `    + ${rule.capability}`),
      ...grant.deny.map((rule) => `    - ${rule.capability}`),
    ];
    throw new Error(
      `No rule for "${capability}" on ${key} in profile "${resolution.profile}".\n` +
        (rules.length > 0
          ? `  Rules on that connection:\n${rules.join('\n')}`
          : `  That connection has no rules at all.`),
    );
  }

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  // Two independent sequences, so neither removal shifts the other's index.
  // `policyRule` refuses a duplicate, so there is at most one match per list.
  for (const { effect, at } of effects) document.removeFrom(['grants', index, effect], at);
  await document.save();

  await recordConfigChange(
    config.instance.profile,
    resolution.workspaceRoot,
    target,
    {
      capability: 'config.policy.remove',
      scope: resolution.profile,
      connection: key,
      arguments: { capability, effects: effects.map((found) => found.effect) },
    },
    (note) => print(warn(note)),
  );

  announce(resolution);
  for (const { effect } of effects) {
    const sign = effect === 'allow' ? style.green('+') : style.red('-');
    print(ok(`removed ${sign} ${style.bold(capability)} on ${style.bold(key)}`));
  }

  if (effects.some((found) => found.effect === 'deny')) {
    print(style.dim('  That capability is no longer denied here; default deny still applies.'));
  }

  // Removing an owner-layer *allow* does not keep the surface off: a profile
  // arrives with the owner layer granted (ADR-050), and `ensureOwnerLayer`
  // writes the row back on the next `start`, `connect` or `deploy`. That repair
  // deliberately stands down for a deny — "a deny is the way it stays off, so
  // it is the one thing this must not undo" — so saying which of the two does
  // what the caller wanted is the difference between this command and a change
  // that quietly reverts a few minutes later.
  const provider = key.slice(0, key.indexOf('.'));
  if (effects.some((found) => found.effect === 'allow') && RESERVED_PROVIDER_IDS.includes(provider)) {
    print(
      style.dim(
        `  ${provider} is an owner surface, so start, connect and deploy will grant it again.\n` +
          `  To keep it off: lanes link policy deny ${capability} --connection ${key}`,
      ),
    );
  }

  // Removing a deny **widens** what an agent may do, so this has to reach the
  // running endpoint. A widening the endpoint never hears about is a permission
  // change the operator believes they made and did not — the defect #288 found
  // in `revoke`, which went from save to emit with no publish at all.
  print(style.dim(`  ${nextAfterEdit(await publishProfileEdit({ resolution, config, target }))}`));
}

export async function configShow(flags: GlobalFlags): Promise<void> {
  const { selection } = await resolveProfileOnly(flags);
  announceProfile(selection);
  const { config } = await loadConfigFile(selection.profilePath);
  print(JSON.stringify(config, null, 2));
}
