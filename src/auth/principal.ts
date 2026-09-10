/**
 * Who is acting, and what they may open.
 *
 * Split from `./index.ts`, which answers a different question. This file is the
 * model — a principal, the profiles it reaches, and the one check that reads
 * them. That file is the machinery that turns an `Authorization` header into
 * one of these. Keeping them apart is what makes the rule below greppable:
 * every way of becoming a principal is in this file, so every way of reaching
 * the whole workspace is too.
 */

/**
 * Every profile the workspace holds, as a value rather than as an absence.
 *
 * This used to be `undefined`, and the difference is the whole of ADR-078. An
 * optional field defaults to the widest possible answer when nobody sets it, so
 * *forgetting* to resolve a member list read as "reaches everything" — which is
 * exactly what a subject-less token did, twice, on the two paths in
 * `./remote.ts`. Written down, the widest answer has to be chosen, and a
 * reviewer can grep for who chose it.
 *
 * Legitimately: the stdio pipe, which is its own proof, because a process that
 * can write to it already has the operator's shell; the CLI, for the same
 * reason; and generation building, which advertises what the *workspace* holds
 * before any caller is known. Nothing reachable over HTTP may carry it.
 */
export const EVERY_PROFILE = 'lanes:every-profile' as const;

/** What a caller may open: a resolved list, or the whole workspace. */
export type Reach = readonly string[] | typeof EVERY_PROFILE;

export interface Principal {
  readonly id: string;
  readonly profile: string;
  readonly kind: 'owner' | 'member' | 'machine';
  /**
   * Every profile this caller may reach.
   *
   * Required, and `EVERY_PROFILE` is the only way to say "all of them". Every
   * token, static or issued, carries a list: a `member`'s because the list *is*
   * the delegation (ADR-060), and a `machine`'s because a bearer token names
   * the person it was issued to rather than opening everything (ADR-068). An
   * empty list is a caller who reaches nothing, which is a normal outcome and
   * not an error.
   */
  readonly profiles: Reach;
}

/**
 * The operator, at their own keyboard, reaching everything.
 *
 * **Not reachable over HTTP, and `src/architecture.test.ts` holds that.** The
 * owner principal is the answer for a pipe or a terminal, where the credential
 * *is* the machine and there is no subject to resolve. Over HTTP there is
 * always a credential, so there is always a person to name, and a fallback to
 * this one is how a request that failed to identify anybody ended up reaching
 * every profile in the workspace.
 */
export function ownerPrincipal(profile: string): Principal {
  return { id: `${profile}:owner`, profile, kind: 'owner', profiles: EVERY_PROFILE };
}

/**
 * A person, and the profiles whose `members:` name them.
 *
 * `profile` carries the one this call is acting within, which is what the audit
 * log records and what policy is evaluated against. `profiles` is the whole set
 * they may choose from, and `mayReach` is the check — kept here rather than in
 * the dispatcher so discovery and enforcement cannot answer it differently,
 * which is the same rule `allowedConnections` follows on the capability axis.
 */
export function memberPrincipal(
  subject: string,
  profile: string,
  profiles: readonly string[],
): Principal {
  return { id: subject, profile, kind: 'member', profiles };
}

/**
 * A static token's holder, and the profiles whose `members:` name them.
 *
 * The same shape as `memberPrincipal` and deliberately so — `kind` is the only
 * difference, and it exists for the audit log rather than for policy. ADR-060
 * described this principal and nothing minted one: the static token resolved to
 * `ownerPrincipal`, reaching every profile in the workspace, which made it the
 * one credential here that never had to say who was holding it. A row in
 * `tokens:` names a subject (ADR-068), so this resolves the same way an OAuth
 * token does and `mayReach` gets no special case.
 */
export function machinePrincipal(
  subject: string,
  profile: string,
  profiles: readonly string[],
): Principal {
  return { id: subject, profile, kind: 'machine', profiles };
}

/**
 * The same caller, acting within a different profile.
 *
 * An endpoint serves several profiles and a principal is built once, from the
 * primary — so the profile on it is where the *connection* was opened, not
 * where this call is going. Every dispatch has to say which, because
 * `principal.profile` is what the audit event records and what `mayReach` is
 * checked against; without this the log attributes a member's call to a profile
 * they may never have been able to reach.
 *
 * It does not widen anything. `profiles` carries over untouched, so a name this
 * caller may not reach is still refused — one step later, by the check below.
 */
export function forProfile(principal: Principal, profile: string): Principal {
  return principal.profile === profile ? principal : { ...principal, profile };
}

/**
 * Whether this caller may act within the named profile.
 *
 * Deny by default: an unresolved list is an empty one, and an empty one reaches
 * nothing. The only way past is a name on the list or a deliberate
 * `EVERY_PROFILE`, which no credential arriving over HTTP carries.
 */
export function mayReach(principal: Principal, profile: string): boolean {
  return principal.profiles === EVERY_PROFILE || principal.profiles.includes(profile);
}

/**
 * The caller's reach as a plain list, for somewhere that cannot hold a sentinel.
 *
 * `ProviderContext.profiles` is the one consumer: it tells a provider which
 * profiles the *caller* has, and a provider has no business knowing the
 * workspace's whole set. So `EVERY_PROFILE` collapses to the profile in play,
 * which is the only honest answer available without knowing what the endpoint
 * is serving. Narrowing, never widening — a member's list passes through
 * untouched.
 */
export function reachWithin(principal: Principal): readonly string[] {
  return principal.profiles === EVERY_PROFILE ? [principal.profile] : principal.profiles;
}
