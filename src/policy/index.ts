/**
 * Policy evaluation.
 *
 * This is the product. `gmail.search = allow` and `gmail.send = deny` are
 * decisions the runtime enforces, not instructions a model is asked to respect.
 * Everything else in this codebase exists to make this module's answer binding.
 *
 * Two invariants, both tested:
 *
 *   1. DEFAULT DENY. Nothing is reachable unless a rule grants it. An empty
 *      policy grants nothing at all.
 *   2. TIGHTEN ONLY. Composition can narrow, never widen. A profile rule can
 *      deny what the instance floor allowed; it can never allow what the floor
 *      withheld. The floor is empty in M1 — the invariant is implemented
 *      anyway, because it is what makes delegated access safe to add later,
 *      and retrofitting it once rules exist in the wild is not possible.
 */

export type { AuthorizationResult } from '#audit';
import type { AuthorizationResult } from '#audit';

export type { LimitConfig } from './limits.ts';
export { RateLimiter, DEFAULT_LIMITS } from './limits.ts';

/**
 * `approval_required` is RESERVED. The model carries the state so that
 * configuration written today stays loadable, but there is no approval engine
 * and a rule carrying it is treated as `deny` until one exists — failing
 * closed rather than silently permitting.
 */
export type Effect = 'allow' | 'deny' | 'approval_required';

export interface PolicyRule {
  /** `*`, `gmail.*`, or `gmail.search`. Those three forms, and no others. */
  readonly capability: string;
  readonly effect: Effect;
  readonly expiresAt?: Date;
}

export interface PolicyDocument {
  readonly rules: readonly PolicyRule[];
}

export const EMPTY_POLICY: PolicyDocument = { rules: [] };

export interface PolicyRequest {
  /**
   * The authenticated principal. One per profile in M1 (the owner). Carried
   * explicitly so that adding delegated principals later is new rows rather
   * than a new signature on the dispatch path.
   */
  readonly principal: string;
  /** Fully qualified, e.g. `gmail.search`. */
  readonly capability: string;
  /**
   * Fully qualified, e.g. `gmail.main`.
   *
   * Carried for audit, not for the decision: rules name capabilities only, so
   * every account of a provider within a profile is governed identically.
   * Granularity between accounts comes from a second profile, which shares no
   * database, credential store, or URL with the first.
   */
  readonly connection: string;
  /** Defaults to now; injectable so expiry is testable without clock games. */
  readonly at?: Date;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: AuthorizationResult;
  readonly matched?: PolicyRule;
}

/** `*` matches everything, `gmail.*` matches one provider, otherwise literal. */
export function capabilityMatches(pattern: string, capability: string): boolean {
  if (pattern === '*') return true;
  if (pattern === capability) return true;
  if (!pattern.endsWith('.*')) return false;
  const prefix = pattern.slice(0, -1); // keep the dot: `gmail.*` -> `gmail.`
  return capability.startsWith(prefix);
}

export function isRuleActive(rule: PolicyRule, at: Date): boolean {
  return rule.expiresAt === undefined || rule.expiresAt > at;
}

function findMatch(
  document: PolicyDocument,
  request: PolicyRequest,
  at: Date,
  effects: readonly Effect[],
): PolicyRule | undefined {
  return document.rules.find(
    (rule) =>
      effects.includes(rule.effect) &&
      isRuleActive(rule, at) &&
      capabilityMatches(rule.capability, request.capability),
  );
}

/**
 * Evaluate one profile document. Deny wins over allow regardless of order, so
 * rule ordering in a config file cannot change the answer — a denial is never
 * something you can accidentally out-rank by putting an allow above it.
 */
export function evaluateDocument(
  document: PolicyDocument,
  request: PolicyRequest,
): PolicyDecision {
  const at = request.at ?? new Date();

  const denial = findMatch(document, request, at, ['deny', 'approval_required']);
  if (denial) {
    return { allowed: false, reason: 'denied_by_policy', matched: denial };
  }

  const allowance = findMatch(document, request, at, ['allow']);
  if (allowance) {
    return { allowed: true, reason: 'allowed', matched: allowance };
  }

  return { allowed: false, reason: 'denied_default' };
}

/**
 * Compose an optional instance floor with the profile's policy.
 *
 * Monotonically tightening: the floor is evaluated first and its denial is
 * final. The profile document is only ever consulted to narrow further, so
 * there is no arrangement of profile rules that can widen past the floor.
 */
export function evaluate(
  request: PolicyRequest,
  profile: PolicyDocument,
  floor?: PolicyDocument,
): PolicyDecision {
  if (floor) {
    const floorDecision = evaluateDocument(floor, request);
    if (!floorDecision.allowed) return floorDecision;
  }
  return evaluateDocument(profile, request);
}

/**
 * The connections a principal may use for a given capability.
 *
 * This is what populates the `connection` argument enum, so a client cannot
 * even discover a connection it has no grant for. Discovery filtering and
 * invocation enforcement therefore share one implementation — if they were
 * separate, they could disagree, and a leak in discovery is still a leak.
 */
export function allowedConnections(
  capability: string,
  connections: readonly string[],
  principal: string,
  profile: PolicyDocument,
  floor?: PolicyDocument,
  at?: Date,
): string[] {
  // Only this capability's own provider. `gmail.search` must never offer a
  // Notion account, and that constraint is structural rather than a policy
  // decision — it used to fall out of rules naming a connection, so dropping
  // that had to put it back explicitly.
  const provider = capability.slice(0, capability.indexOf('.'));
  const ofProvider = connections.filter((connection) => connection.startsWith(`${provider}.`));

  // All or nothing beyond that, since rules do not discriminate between
  // accounts. The list shape is kept because it is what the `connection` enum
  // wants, and because a future principal-scoped rule would restore the
  // filtering without touching any caller.
  const first = ofProvider[0];
  if (first === undefined) return [];

  const request: PolicyRequest = at
    ? { principal, capability, connection: first, at }
    : { principal, capability, connection: first };

  return evaluate(request, profile, floor).allowed ? ofProvider : [];
}
