import { workspaceRootFor } from './authorise.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * How one process serves a request for one workspace.
 *
 * The obvious way is wrong, and it is worth naming because it is what a reader
 * will assume happened: setting `process.env.LANES_LINK_HOME` before the call
 * and restoring it after. A single process handling concurrent requests cannot
 * do that. The second request overwrites the first mid-flight and the failure
 * is one workspace reading another's configuration, which is the exact thing
 * this component exists to prevent — arrived at through the plumbing rather
 * than through the gate.
 *
 * It does not have to. `resolveWorkspaceRoot` already takes an `env`, and
 * `resolveProfile` already threads one, because both were written to be
 * testable without touching the real environment. That seam is what makes a
 * multi-tenant control plane possible without changing a single command: a
 * request carries its own environment, explicitly, and `process.env` is never
 * written.
 *
 * There is no `AsyncLocalStorage` here for the same reason ADR-037 removed
 * implicit selection from the CLI. An ambient value that decides which
 * workspace a call acts on is the shape that lets a command run against the
 * wrong thing, and it reads identically to one that ran against the right thing.
 */

/**
 * What a managed workspace calls its target.
 *
 * A workspace *is* a target since ADR-052, and a managed one declares exactly
 * one. Fixed rather than configurable: the name is an implementation detail of
 * how Lanes provisions the workspace, and a second spelling would be a second
 * answer to which adapters a request opens.
 */
export { MANAGED_TARGET } from '#profile';

/**
 * The environment one request runs in.
 *
 * A copy, with the root replaced. Copied rather than built empty because other
 * adapters read the environment for their own reasons — a credential key, a
 * region — and those are properties of the deployment rather than of the
 * caller. The root is the one thing that belongs to the request.
 *
 * The ambient root is overridden rather than deferred to. The container sets
 * one for its own startup, and a request served from it would be a request
 * served from whatever workspace happened to boot the process.
 */
export function environmentFor(
  assertion: ControlAssertion,
  ambient: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...ambient, LANES_LINK_HOME: workspaceRootFor(assertion) };
}
