import type { Runtime } from '#cli/runtime.ts';
import type { DoctorFinding } from './inspect.ts';

/**
 * Whether anybody can actually reach this profile.
 *
 * Two fields decide it and neither is repaired by anything: `profile add` seeds
 * them at creation and no sweep revisits them, so a profile older than the
 * template that wrote them stays as it was.
 *
 * **Empty `members:` is nobody, not everybody** — deny applied to the identity
 * axis (ADR-060). It has always meant that over `/mcp`, but the dashboard used
 * to read every profile regardless, so ADR-079 is the first release where an
 * untouched one also vanishes from a page its owner was reading. That is the
 * shape of the fix and not a regression; what it needs is to be *said*, because
 * an empty list reads naturally as "no restriction" and means the opposite.
 *
 * **No `auth.authorization` is nobody either**, one step further back: without
 * it there is no authorization server on this endpoint, so there is nothing for
 * a client — or the dashboard — to register against and no way to sign in at
 * all. Every profile the template has written since 0.12 declares `mode: self`,
 * so reaching this needs a hand edit or a profile old enough to predate it.
 *
 * Warnings rather than problems, and named rather than repaired here: both are
 * grants, and widening one silently from a command somebody ran to *diagnose*
 * is the thing ADR-007 is about. `--fix` is the affordance, and it is the
 * operator's to run.
 */
export function reachabilityFindings(runtime: Runtime): DoctorFinding[] {
  const found: DoctorFinding[] = [];
  const profile = runtime.resolution.profile;
  const target = runtime.resolution.target;

  if (runtime.config.members.length === 0) {
    found.push({
      kind: 'profile_lists_nobody',
      key: profile,
      message:
        `${profile} lists no members, so nobody reaches it — not over MCP, and not on the dashboard.\n` +
        '      An empty list is deny, not "no restriction".',
      fix: `lanes link profile members add --me --profile ${profile} --workspace ${target}`,
    });
  }

  if (!runtime.config.auth.authorization) {
    found.push({
      kind: 'profile_cannot_be_signed_in_to',
      key: profile,
      message:
        `${profile} declares no auth.authorization, so this endpoint runs no authorization\n` +
        '      server for it and nobody can sign in — a client has nothing to register against.',
      fix: `add "authorization: { mode: self }" under auth: in ${profile}'s profile.yaml`,
    });
  }

  return found;
}
