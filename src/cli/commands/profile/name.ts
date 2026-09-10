import { ConfigError, configSchema } from '#profile';

/**
 * Refusing a profile name before anything is written for it.
 *
 * The rule was only ever enforced by reading the file back. `createProfile`
 * wrote `profiles/<name>/profile.yaml` and *then* parsed it, so a name the
 * contract does not accept — anything with a hyphen, a capital, a dot —
 * reported an error and left the profile behind. Every command that could have
 * taken it away resolves it first and failed on the same parse, so the only way
 * out was deleting the file by hand, or the bucket object on a deployed
 * workspace. Issue #219.
 *
 * The guard sits in front of the first write rather than beside it because
 * `profile add` on an empty directory writes three things — `workspaces.yaml`,
 * `connections.yaml`, then the profile — and a name that cannot be used should
 * not bring a workspace into existence on its way to being refused.
 */

/**
 * The one spelling of the rule, reached through the schema that enforces it.
 *
 * Not a second regex here. `instance.profile` is `identifier`
 * (`profile/primitives.ts`), and a copy of that pattern in the guard would be
 * free to drift from the copy in the parse — which is the same failure this
 * whole file exists to remove, one release later and harder to see: a name the
 * guard accepts and the loader does not is exactly the leftover again. Reading
 * the field means the message below is also the loader's own wording, so an
 * operator who somehow reaches both is told the same thing twice rather than
 * two different things.
 */
const rule = configSchema.shape.instance.shape.profile;

/**
 * The nearest name the rule accepts, where folding gets to one.
 *
 * Case and separators are what people actually type — `my-profile`, `My
 * Profile`, `work.2` — and all three fold cleanly. Punctuation is all this
 * drops: `2fa` would fold to `fa`, which is a legal name and a *different* one,
 * so a leading digit gets no suggestion at all. Inventing a name for somebody
 * is worse than stating the rule and letting them choose it.
 *
 * The result is put back through the rule rather than assumed to satisfy it,
 * which is what makes the folding above a heuristic that cannot be wrong: a
 * suggestion the guard would itself go on to refuse is not offered.
 */
export function nearestProfileName(name: string): string | undefined {
  const folded = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');

  return folded !== name && rule.safeParse(folded).success ? folded : undefined;
}

/**
 * Throw unless `name` is one the config contract will accept.
 *
 * `target` only shapes the suggestion, so a caller that has not resolved one
 * yet may leave it out; the command printed then names `<name>` where the
 * workspace goes, which is what the rest of the CLI's usage lines do.
 */
export function assertProfileName(name: string, target?: string | undefined): void {
  const checked = rule.safeParse(name);
  if (checked.success) return;

  const why = checked.error.issues[0]?.message ?? 'not a name the config contract accepts';
  const nearest = nearestProfileName(name);
  const suggestion = nearest
    ? `\n  Try: lanes link profile add ${nearest} --workspace ${target ?? '<name>'}`
    : '';

  // That nothing was written is the sentence worth printing. The defect this
  // replaces reported an error *and* left a profile, so an operator who has
  // seen the old behaviour has every reason to go looking for the litter.
  throw new ConfigError(`Profile name "${name}": ${why}.${suggestion}\n  Nothing was written.`);
}
