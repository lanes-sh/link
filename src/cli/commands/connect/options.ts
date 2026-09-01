import type { GlobalFlags } from '../../runtime.ts';

/**
 * What `lanes link connect` accepts, and what it hands back.
 *
 * Split out of `index.ts` so that file stays inside the size budget. The seam is
 * the one the command already has: this is the shape of the request, and that is
 * the six steps that carry it out.
 */

/**
 * `lanes link connect <provider>` — the one command that adds an account.
 *
 * The same command regardless of connectivity. A local provider declares a
 * connection and stops; an MCP provider authorises, asks the upstream server
 * what it exposes, and grants it. Core learns nothing about any vendor: the
 * manifest says how to reach them and what to ask the operator for.
 *
 * The five numbered steps below are the whole command, and each one that grew
 * past a paragraph moved out: `authorise.ts` gets the token, `setup.ts` asks the
 * operator for what the vendor's console produced, `settle.ts` works out whose
 * account it was, and `accounts.ts` knows which connections are siblings.
 */

export interface ConnectOptions extends GlobalFlags {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  /** `--set key=value`, repeatable: where this connection's service is. */
  readonly set?: readonly string[] | string | undefined;
  /**
   * `--label`: what to call this connection, instead of being asked.
   *
   * Distinct from `--display-name`, which answers *whose account this is* for a
   * provider that cannot report it. This one never touches the identity, so it
   * is safe to pass anything a person would say out loud.
   */
  readonly label?: string | undefined;
  /** Ask for the stored credential again — a key rotated, or a password revoked. */
  readonly replace?: boolean | undefined;
  /**
   * Answer nothing from a terminal: resolve every declared value from the
   * credential store, and refuse with instructions where one is missing.
   */
  readonly nonInteractive?: boolean | undefined;
  /** The operator has already agreed to scopes broader than the provider needs. */
  readonly acceptBroadScopes?: boolean | undefined;
  /**
   * Register an OAuth client of your own rather than using a hosted one.
   *
   * Sticky by consequence rather than by flag: it writes the `oauth_apps` entry,
   * and a profile that declares one is never moved off it. So this is typed once
   * and then forgotten, which is the right shape for a decision about a client
   * that is shared by every connection of that vendor.
   */
  /**
   * `--own-client`, the older spelling of one of the routes `--auth` now names.
   *
   * Kept because it is in scripts and in a year of documentation, and because
   * it still says something true. It resolves to `--auth own_client`.
   */
  readonly ownClient?: boolean | undefined;
  /**
   * `--auth <method>`: which way in, for a provider that offers more than one.
   *
   * Unset means ask, where there is somebody to ask and something to ask
   * about. It is not sticky the way `--own-client` is: `--own-client` writes an
   * `oauth_apps` entry that every connection of the vendor then reads, whereas
   * this decides one connection's credential and is recorded by that credential
   * existing. Two accounts on the same profile may honestly differ.
   */
  readonly auth?: string | undefined;
  /** Injected for tests. The broker is the only thing `connect` fetches. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly json?: boolean | undefined;
}


/**
 * The connection id used before the provider has said whose account this is.
 *
 * It is a placeholder rather than a name, and `setup.ts` reads it as one: a
 * credential filed under it belongs to a `connect` that did not finish.
 */
