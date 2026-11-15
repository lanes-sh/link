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
 * **The key is the grant ref, not the bare id.** `connectionsOf` fills the enum
 * from the grant rows (ADR-058), so `reachable` carries `gmail.con1`, and
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
