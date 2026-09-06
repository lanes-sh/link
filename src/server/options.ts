import type { Authenticator } from '#auth';
import type { ControlDeps } from '#control/routes.ts';
import type { Logger } from '#connectivity';
import type { AuthorizationSurface } from './oauth.ts';
import type { Generations } from './generations.ts';
import type { ReadDeps } from './read/routes.ts';

/**
 * What a bound server is configured with.
 *
 * Its own file because it is a different subject from what a request does:
 * every field here is a property of the *bind* — which profile is primary, what
 * credential opens it, which surfaces are mounted — decided once by `serve()`
 * and then fixed for the life of the socket. `index.ts` is what happens per
 * request.
 *
 * Separated when `index.ts` crossed the file-size budget and the alternative
 * was raising the number. The seam the budget pointed at is this one: ten
 * declarations, each carrying the reasoning for one decision, sitting inside a
 * file about request handling. `#profile/schema.ts` is the same shape for the
 * same reason — its length is the size of the config format rather than a count
 * of responsibilities.
 */

export interface ServerOptions {
  /** The current profile runtimes, and the reload that replaces them. */
  readonly generations: Generations;
  /** Which profile's port, host, and token govern the endpoint itself. */
  readonly primary: string;
  readonly authenticator: Authenticator;
  readonly log: Logger;
  readonly version?: string;
  /**
   * How a remote client obtains a token, when the profile declares one.
   *
   * Absent means bearer-token-only: no metadata is published, the `401` carries
   * no pointer, and the endpoint behaves exactly as it did before.
   */
  readonly authorization?: AuthorizationSurface | undefined;
  /** Hostnames this endpoint answers to. See `./rebinding.ts`. */
  readonly allowedHostnames?: readonly string[] | undefined;
  /**
   * Meter the surface that answers before authentication.
   *
   * A property of what this is bound to, exactly as `cors` and
   * `allowedHostnames` are, and decided in the same lines of `serve()`. Off on
   * loopback, and that is not a gap: what the ceiling protects is a
   * credential-store call over the network and an object written to a bucket,
   * and on loopback both are a local file belonging to whoever is already
   * standing at the machine. `./rebinding.ts` refuses the one caller that is not
   * — a page the owner happens to be visiting — before this would be reached.
   */
  readonly meterUnauthenticated?: boolean | undefined;
  /**
   * The dashboard's read surface, when this bind may serve it (ADR-064).
   *
   * Another property of the bind address, decided in the same lines of
   * `serve()` as `cors` and the meter. Absent on loopback, where the TLS
   * listener in `./read/open.ts` serves it on its own port instead — a
   * cross-origin grant on `127.0.0.1` is what `./rebinding.ts` refuses
   * outright, and ADR-039's rule is not being relaxed to fit this in.
   */
  readonly read?: ReadDeps | undefined;
  /**
   * The managed control surface, when this runtime serves one.
   *
   * Absent on every self-hosted and local bind, which is what keeps those
   * endpoints exactly as they were: no control routes, and ADR-007's "a running
   * instance never mutates its own configuration" literally true for them.
   *
   * Present only on a Lanes-managed runtime, which is `--no-allow-unauthenticated`
   * and reachable by the api's service account alone. See `#control/routes.ts`
   * for why that is what makes mounting this safe rather than a relaxation.
   */
  readonly control?: ControlDeps | undefined;
}
