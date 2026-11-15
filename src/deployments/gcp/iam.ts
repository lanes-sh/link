import type { DeployStep } from '../driver.ts';

/**
 * Bindings a deploy did not write, and what to do about the ones it replaced.
 *
 * **`add-iam-policy-binding` adds.** It is keyed on the whole binding —
 * role, member *and* condition — so changing a condition's expression does not
 * edit the binding, it writes a second one beside the first. IAM then evaluates
 * the set as a permissive union: whichever expression is widest wins, and the
 * narrowing the new one describes never happens.
 *
 * That is not hypothetical. Every step in `provision.ts` tolerates failure, so
 * two rejected attempts at a condition left `reads-its-config` sitting at
 * `expression=true` — `objectViewer` on every object in the bucket, under a
 * title claiming the opposite, and the exact state ADR-007 exists to prevent.
 * Three deploys since have each added a correct binding beside it and changed
 * nothing about what the revision could read.
 *
 * So a deploy has to *remove* what it supersedes, and the removal has to name
 * the old binding exactly. Nothing here keeps a record of what the last deploy
 * wrote — `docs/detailed/init.md` rules out state files, leases and drift
 * reconciliation, and a record would only ever agree with itself anyway. The
 * policy is read instead: IAM is the thing that actually decides, so IAM is what
 * gets asked, the same argument `unboundRotatableRefs` makes for `doctor`.
 */

/** One binding, as `get-iam-policy --format=json` returns it. */
export interface PolicyBinding {
  readonly role?: string | undefined;
  readonly members?: readonly string[] | undefined;
  readonly condition?:
    | {
        readonly title?: string | undefined;
        readonly expression?: string | undefined;
        readonly description?: string | undefined;
      }
    | undefined;
}

/** A binding this deploy writes: a role, and the condition that scopes it. */
export interface ConditionedGrant {
  readonly role: string;
  readonly title: string;
  readonly expression: string;
}

/**
 * Reading a policy this deploy is about to change.
 *
 * An interface rather than a direct call so `provisionSteps` stays what it is —
 * a pure function from a target to a list of commands — and so every test of it
 * runs with no cloud project near it. Absent means "nothing was asked", which
 * plans no removals at all: a deploy that cannot see the current policy must not
 * guess at what to take away.
 */
export interface PolicyReader {
  /** The bucket's own policy, or null when it could not be read. */
  bucket(bucket: string): Promise<readonly PolicyBinding[] | null>;
  /** The project's policy, on the same contract. */
  project(project: string): Promise<readonly PolicyBinding[] | null>;
  /**
   * One secret's policy, by its encoded id, on the same contract.
   *
   * Answering at all also answers whether the secret exists, which is the one
   * question Secret Manager will not answer directly: it returns 403 rather
   * than 404 for a binding an identity does not hold, so that secrets cannot be
   * enumerated by their error codes. A policy that came back is a secret that
   * is there and readable; `null` is "could not look", and could be either.
   *
   * **Takes the project as well as the id**, because a secret is the one
   * resource here that `gcloud` cannot locate from its name alone: it resolves
   * an unqualified id against whatever `core/project` happens to be, which in a
   * deploy is a property of the operator's shell rather than of the target. A
   * dry run against a real project caught this answering `NOT_FOUND` for every
   * secret that was in fact there, which `null` renders as "could not look" —
   * so nothing was skipped and nothing failed, and the saving silently was not
   * one.
   */
  secret(project: string, id: string): Promise<readonly PolicyBinding[] | null>;
}

/** Whether an existing binding is exactly one of the grants being applied. */
function isDesired(binding: PolicyBinding, desired: readonly ConditionedGrant[]): boolean {
  return desired.some(
    (grant) =>
      grant.role === binding.role &&
      grant.title === binding.condition?.title &&
      grant.expression === binding.condition?.expression,
  );
}

/**
 * The bindings on this resource that an earlier version of this deploy wrote and
 * this one no longer means.
 *
 * Two shapes qualify, and both are things only a deploy puts there:
 *
 *   - **A condition with one of our titles and a different expression.** The
 *     `owns-its-data` binding that still names `skills/`, the `reads-its-config`
 *     one still saying `true`. Matched on the title rather than on the role, so
 *     that changing which role carries a title cleans the old one up too.
 *   - **An unconditioned binding on a role we only ever grant conditionally.**
 *     A grant with no condition is the whole bucket, which is the thing the
 *     condition exists to prevent; there is no version of this deploy for which
 *     it is the right answer.
 *
 * Anything else on the policy is left alone — other members, other roles, and
 * every binding a human added deliberately.
 */
export function supersededBindings(input: {
  readonly current: readonly PolicyBinding[];
  readonly member: string;
  readonly desired: readonly ConditionedGrant[];
}): PolicyBinding[] {
  const titles = new Set(input.desired.map((grant) => grant.title));
  const roles = new Set(input.desired.map((grant) => grant.role));

  return input.current.filter((binding) => {
    if (!(binding.members ?? []).includes(input.member)) return false;
    if (isDesired(binding, input.desired)) return false;

    const title = binding.condition?.title;
    if (title !== undefined) return titles.has(title);
    return binding.role !== undefined && roles.has(binding.role);
  });
}

/**
 * A condition as `--condition` wants it, delimiter and all.
 *
 * gcloud parses this value as comma-separated `key=value` pairs, so an
 * expression containing a comma silently becomes two keys — and the removal has
 * to match the stored condition *exactly*, including its description, or it
 * removes nothing and reports that it removed nothing. The `^X^` prefix picks a
 * different delimiter, which is gcloud's own escape for this (`gcloud topic
 * escaping`).
 *
 * None of the expressions this repository writes contains a comma. The one being
 * removed came off the policy, though, and so was written by some other version
 * of this file.
 */
export function conditionFlag(condition: NonNullable<PolicyBinding['condition']>): string {
  const parts: [string, string][] = [
    ['title', condition.title ?? ''],
    ['expression', condition.expression ?? ''],
    ...(condition.description ? ([['description', condition.description]] as [string, string][]) : []),
  ];

  const text = parts.map(([key, value]) => `${key}=${value}`).join('');
  const delimiter = [',', ';', ':', '#', '~', '%'].find((candidate) => !text.includes(candidate));
  if (delimiter === undefined) {
    // Six delimiters and every one of them is in the expression. Nothing this
    // repository writes gets here; a binding that does is left in place rather
    // than removed by an argv that would mean something else.
    return '';
  }

  const joined = parts.map(([key, value]) => `${key}=${value}`).join(delimiter);
  return delimiter === ',' ? joined : `^${delimiter}^${joined}`;
}

/**
 * The command that takes one superseded binding away.
 *
 * Always after the step that adds its replacement, never before. The two are one
 * edit to a live policy, and doing them the other way round opens a window —
 * seconds by the clock, longer once propagation is counted — in which the
 * revision that is currently serving holds no grant at all.
 *
 * `null` for a binding whose condition cannot be spelled as an argument, which
 * leaves it in place: an approximate `--condition` matches nothing, or worse,
 * matches something else.
 */
export function removalStep(input: {
  readonly resource: readonly string[];
  readonly member: string;
  readonly binding: PolicyBinding;
  readonly title: string;
}): DeployStep | null {
  const condition = input.binding.condition;
  const flag = condition ? conditionFlag(condition) : 'None';
  if (flag === '') return null;

  return {
    title: input.title,
    argv: [
      ...input.resource,
      '--member',
      input.member,
      '--role',
      input.binding.role ?? '',
      '--condition',
      flag,
    ],
    tolerateFailure: true,
    removes: true,
  };
}

/**
 * Whether a policy already carries exactly the binding a deploy is about to add.
 *
 * `add-iam-policy-binding` is not free and is not quiet: it is a read-modify-
 * write of the whole policy, and the runner prints `+ done` for it whether or
 * not anything changed. Thirty-seven of them ran on one `profile add` and every
 * one was already in place.
 *
 * `null` is never evidence. A policy that could not be read is not a policy
 * without the binding, so the step is kept — the same direction
 * `supersededBindings` takes when it cannot look.
 */
export function holdsGrant(
  current: readonly PolicyBinding[] | null,
  member: string,
  grant: ConditionedGrant,
): boolean {
  return (current ?? []).some(
    (binding) => (binding.members ?? []).includes(member) && isDesired(binding, [grant]),
  );
}

/**
 * The same question for a binding carrying no condition, which is every grant
 * on a secret: they are scoped by naming one resource, so none of them needs one.
 *
 * A *conditioned* binding on the same role does not count. It grants something
 * narrower than what is being asked for, and treating it as satisfaction is how
 * a deploy would decide it had a permission it does not have.
 */
export function holdsUnconditioned(
  current: readonly PolicyBinding[] | null,
  member: string,
  role: string,
): boolean {
  return (current ?? []).some(
    (binding) =>
      binding.role === role &&
      !binding.condition &&
      (binding.members ?? []).includes(member),
  );
}
