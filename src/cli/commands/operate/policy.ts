import { loadConfigFile } from '#profile';
import { ConfigDocument } from '../../config-edit.ts';
import { announce, announceProfile, heading, ok, print, style, table } from '../../output.ts';
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

  if (config.policy.allow.length === 0 && config.policy.deny.length === 0) {
    print(style.dim('No rules. Default deny is in effect: nothing is reachable.'));
    return;
  }

  const expiry = (rule: { capability: string; expires_at?: string | undefined }) =>
    rule.expires_at ? style.dim(`until ${rule.expires_at}`) : '';

  if (config.policy.allow.length > 0) {
    heading('Allow');
    table(config.policy.allow.map((rule) => [`  ${style.green('+')}`, rule.capability, expiry(rule)]));
  }

  if (config.policy.deny.length > 0) {
    heading('Deny');
    print(style.dim('  A deny beats any allow, whatever the order in the file.'));
    table(config.policy.deny.map((rule) => [`  ${style.red('-')}`, rule.capability, expiry(rule)]));
  }

  print('');
  print(
    style.dim('Rules cover every account of a provider. For different grants, use a second profile.'),
  );
}

export async function policyRule(
  effect: 'allow' | 'deny',
  capability: string,
  flags: GlobalFlags,
): Promise<void> {
  const { resolution, config, target } = await resolveProfile(flags);
  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);

  if (config.policy[effect].some((rule) => rule.capability === capability)) {
    print(style.dim(`${effect} ${capability} is already declared.`));
    return;
  }

  // A bare string, because that is what the file should read like. The object
  // form exists for `expires_at` and is not worth writing by default.
  document.addTo(['policy', effect], capability, { inline: true });
  // Validation runs before the write, so a rule naming a provider with no
  // connection fails here rather than silently granting nothing at runtime.
  await document.save();

  announce(resolution);
  print(ok(`${effect} ${style.bold(capability)}`));

  if (effect === 'deny' && config.policy.allow.some((rule) => rule.capability === '*')) {
    print(style.dim('  This narrows the catch-all allow; a deny always wins.'));
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
