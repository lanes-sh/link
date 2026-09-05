import { LANES_SCHEME } from '#deployments/adapters/lanes.ts';
import { CONTROL_ROLES, type ControlAssertion, type ControlRole } from './assertion.ts';

/**
 * Who may do what, once the assertion has been believed.
 *
 * Three gates guard this service, and they answer three different questions.
 *
 * **The role** — is this person allowed to administer this workspace. Decided
 * by the API against workspace membership and carried in the assertion.
 *
 * **The scope** — did they authorise *this client* to do it on their behalf.
 * Ticked once when the connector was added, and the reason it exists is the
 * chain ADR-007 was written against: an agent that can grant a profile access
 * to a mailbox can then read that mailbox through the endpoint. Being an admin
 * is consent to administer; it is not consent for every agent holding your
 * credential to administer.
 *
 * **The profile's own switch** — is this particular profile open to being
 * changed by an agent at all. That one needs the profile loaded and lives with
 * the routes that load it.
 *
 * Reading passes the first alone. Everything that widens what an agent can
 * reach needs the first two.
 */

/** The scope a credential carries when its owner allowed it to manage config. */
export const LINK_ADMIN_SCOPE = 'link:admin';

export interface Requirement {
  readonly role: ControlRole;
  /** Absent means the act authorises nothing further and needs no consent. */
  readonly scope?: string;
}

/**
 * Listing profiles, connections, grants, members, status.
 *
 * No scope, because reading configuration authorises nothing: the same
 * reasoning ADR-019 uses for the `setup` provider, which describes what
 * connecting would involve and is on the permitted side of ADR-007's line.
 */
export const READS: Requirement = { role: 'editor' };

/**
 * Anything that widens what an agent can reach.
 *
 * Adding or removing a profile, a grant, a policy rule, a member, a connection
 * or a token. The unifying test is ADR-007's: does this authorise *future*
 * agent behaviour.
 */
export const WIDENS: Requirement = { role: 'admin', scope: LINK_ADMIN_SCOPE };

export interface Refusal {
  readonly status: 403;
  readonly message: string;
}

/**
 * Which workspace this call acts in, and the only way a route may name one.
 *
 * Its one parameter is the verified assertion. That is the invariant the
 * component rests on: there is no request body shape that reaches this, so a
 * caller — or a prompt-injected agent driving one — has nothing to influence.
 * A workspace argument would put the tenant boundary in a place an attacker can
 * write to, and no amount of validation afterwards recovers that.
 */
export function workspaceRootFor(assertion: ControlAssertion): string {
  return `${LANES_SCHEME}${assertion.workspace}`;
}

const RANK: Record<ControlRole, number> = { editor: 1, admin: 2 };

/**
 * Null when the caller may proceed, a refusal when they may not.
 *
 * Both unmet gates are reported together. Naming the role alone would send
 * somebody to get promoted and leave them refused for the other reason, which
 * is two round trips to learn one thing.
 */
export function permits(assertion: ControlAssertion, need: Requirement): Refusal | null {
  const missing: string[] = [];

  if (RANK[assertion.role] < RANK[need.role]) {
    missing.push(`the "${need.role}" role in this workspace (you have "${assertion.role}")`);
  }

  if (need.scope !== undefined && !assertion.scopes.includes(need.scope)) {
    missing.push(
      `the "${need.scope}" scope, which is the box allowing this client to manage your ` +
        'Lanes Link configuration. Re-add the connector and tick it',
    );
  }

  if (missing.length === 0) return null;

  return {
    status: 403,
    message: `This action needs ${missing.join(', and ')}.`,
  };
}

/** Every role, for a caller wanting to render the set rather than restate it. */
export { CONTROL_ROLES };
