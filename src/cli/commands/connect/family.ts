import type { ProviderRegistry } from '#registry';
import { progress, style } from '../../output.ts';
import { credentialApp, familyNote } from './accounts.ts';
import { familyOutcome, type ConnectOutcome } from './outcome.ts';

/**
 * `lanes link connect icloud` — an account rather than a provider.
 *
 * Everyone models iCloud this way: Apple's own Settings, macOS Internet
 * Accounts, Thunderbird, DAVx⁵. One authorisation, three services. It is three
 * *providers* underneath because mail and calendars are different protocols,
 * and because a policy line per provider is what lets someone allow
 * `icloud_calendar.*` while never granting mail — but nobody should have to
 * know that to connect their account.
 *
 * Its own file because it is its own subject: `runConnect` is five numbered
 * steps that add one account, and this is the fan-out that turns one name into
 * several of those. Keeping them together made the interesting half — how a
 * partial failure is reported — read as a preamble to be scrolled past.
 */

/**
 * Which providers answer to this name as a shared account.
 *
 * Fewer than two is not a family. Asked of the registry rather than matched on
 * the id, for the reason `siblingAccountId` gives: `app` is a manifest field,
 * and a provider is free to declare `app: icloud` under any name it likes.
 */
export function familyMembers(registry: ProviderRegistry, name: string): readonly string[] {
  return registry
    .list()
    .filter((candidate) => credentialApp(candidate.manifest) === name)
    .map((candidate) => candidate.manifest.id);
}

/**
 * Connect each member in turn, and report the account rather than the services.
 *
 * In sequence, and the order matters: the first settles the account id and
 * stores the credential, and the rest find both already there.
 *
 * The id travels as a flag because the family members are addressed by their
 * own names — `connect icloud.will` parses `will` off a target that is then
 * thrown away, and recursing without it meant the command named an account and
 * each member silently invented its own.
 *
 * `announced` is passed for the same reason and one axis over: the line naming
 * the target belongs to the account, not to each service under it, so it is
 * printed once here and suppressed in every member. Three copies of it is three
 * times nothing new.
 */
export async function connectFamily<Options extends { readonly id?: string | undefined }>(input: {
  readonly name: string;
  readonly members: readonly string[];
  readonly options: Options;
  readonly namedId: string | undefined;
  readonly connect: (
    provider: string,
    options: Options,
    announced: boolean,
  ) => Promise<ConnectOutcome>;
}): Promise<ConnectOutcome> {
  const { name, members, options, namedId, connect } = input;

  progress(style.dim(familyNote(name, members)));

  const inherited = { ...options, id: options.id ?? namedId };
  const outcomes: ConnectOutcome[] = [];
  for (const member of members) outcomes.push(await connect(member, inherited, true));

  return familyOutcome(outcomes);
}
