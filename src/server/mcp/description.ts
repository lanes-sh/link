/**
 * How a tool's description says which accounts it accepts.
 *
 * Its own file because of the seam `index.ts` names: everything in
 * `visibility` decides *what* is exposed and everything else decides *how*, and
 * a discovery leak can only come from the first. This builds a string out of a
 * decision already taken — keeping a formatter in the one file whose whole claim
 * is that it is the only place a leak can originate dilutes that claim, and the
 * claim is load-bearing (ADR-060, ADR-079).
 */

/**
 * Say which accounts are reachable, grouped by profile.
 *
 * Grouped rather than flattened because the two arguments are not independent:
 * `profile: personal` with a connection belonging to `work` is refused, and a
 * flat list would read as though any pairing were valid.
 *
 * **The account, not just the id.** This listed bare ids, and the id is the
 * only thing a model has to choose on — so two accounts of one vendor were
 * `ada_lovelace` and `ada_lovelace2` and nothing said which mailbox either was.
 * `idFromAccount` takes only the local part, so that is what two addresses at
 * different domains actually produce. Picking the wrong one sends mail as the
 * wrong person, which is the same class of failure ADR-056 rules out for
 * entities: ordering is not selection, and a caller that cannot tell two
 * candidates apart must be given what tells them apart.
 *
 * **The key is the grant ref, not the bare id.** `connectionsOf` fills
 * `reachable` from the grant rows (ADR-058), so it carries `gmail.con1`, and
 * `accountsByProfile` keys on that same `ref` — one string from one source, so
 * the two sides cannot drift. Keyed on `connection.id` instead it missed every
 * lookup, and no served description carried an account at all, while
 * `connection-choice.test.ts` passed bare ids in by hand and stayed green.
 * Contract 4 is what turned that from cosmetic into a real loss: the ids used to
 * carry the account and are `con1`, `con2` now, so the id says nothing about
 * which mailbox it is and this annotation is the only thing that does.
 */
export function describeWithConnections(
  description: string,
  reachable: ReadonlyMap<string, readonly string[]>,
  accounts: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): string {
  const lines = [...reachable].flatMap(([profile, connections]) => {
    const known = accounts.get(profile);
    return [
      `  ${profile}:`,
      ...connections.map((id) => `    ${id}${known?.get(id) === undefined ? '' : ` — ${known.get(id)!}`}`),
    ];
  });
  return `${description}\n\nAvailable connections, by profile:\n${lines.join('\n')}`;
}

/**
 * The candidates as a clause, or nothing at all.
 *
 * Empty is reachable on the two surface tools, where the list is the whole
 * endpoint's rather than one capability's: a caller no member list names reaches
 * nothing. `" when this list was built."` with nothing in front of it reads as a
 * bug, so there is no clause at all.
 */
function asOf(names: readonly string[]): string {
  return names.length === 0 ? '' : ` ${names.join(', ')} when this list was built.`;
}

/**
 * What `profile` says, on every tool that takes one.
 *
 * The candidates are named and then disclaimed in the same breath, which is the
 * only shape that survives a list nothing can refresh (ADR-082). Naming them
 * alone is what the enum did, and it tells a caller the set is closed — so a
 * client holding a list from before `profile add` refuses the one name its owner
 * has just handed it. Omitting them loses the at-a-glance list that is most of
 * what makes the argument answerable without a second call.
 *
 * The last sentence is an instruction rather than a pointer somewhere else on
 * purpose: a caller reading this is composing a call, not exploring, and
 * `lanes_setup_overview` is a round trip away from what it already knows.
 */
export function profileDescription(profiles: readonly string[]): string {
  return (
    'Which profile to act within.' +
    asOf(profiles) +
    ' A profile added since is not listed here and is still valid, so pass the name you were given.'
  );
}

/**
 * What `profile` says on `lanes_tools_search`, where it filters rather than routes.
 *
 * The last clause is the whole of the behaviour change ADR-082 makes here, and
 * it is a reduction in what a caller learns: an unreachable name used to be a
 * validation error, distinguishable from a reachable name that matched nothing.
 * Both are now the same empty answer.
 */
export function searchFilterDescription(profiles: readonly string[]): string {
  return (
    'Only this profile.' +
    asOf(profiles) +
    ' One that is not reachable from here returns nothing rather than an error.'
  );
}

/**
 * What `connection` says. Fixed, because the accounts are in the tool's own
 * description already — grouped by profile, with the account beside each opaque
 * id (ADR-073), which is strictly more than the flat enum carried: that enum was
 * deduplicated *across* profiles, so it validated pairings the handler refuses.
 */
export const CONNECTION_DESCRIPTION =
  "Which configured account to act on, within that profile — this tool's description lists them by profile.";
