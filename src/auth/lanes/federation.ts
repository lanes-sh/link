import { AssertionVerifier } from './assertion.ts';
import { DEFAULT_API_URL } from './login.ts';
import type { Federation } from '../oauth/server.ts';

/**
 * The Lanes side of an endpoint's authorization, assembled.
 *
 * Three URLs and a membership lookup. It lives here rather than in
 * `server/endpoint.ts` so that "who does this endpoint believe about identity"
 * is one file with one answer, and so that a self-hoster changing it changes
 * one thing — which is the same reasoning that keeps `oidc` a URL in config
 * rather than a branch in the code.
 *
 * **Both URLs are overridable and neither is a vendor name in the request
 * path.** `LANES_API_URL` and `LANES_WEB_URL` are what a self-hosted
 * deployment sets, and they are also what makes `lanes dev` work against the
 * API running on this machine.
 */

/** Where the consent page lives, unless told otherwise. */
export const DEFAULT_WEB_URL = 'https://lanes.sh';

export interface FederationOptions {
  /** Which profiles a subject may consume, read at the moment a token is minted. */
  readonly profilesFor: (subject: string) => Promise<readonly string[]>;
  readonly apiUrl?: string | undefined;
  readonly webUrl?: string | undefined;
  /** Injected for tests. Nothing in production passes one. */
  readonly fetch?: ConstructorParameters<typeof AssertionVerifier>[0]['fetch'];
}

export function lanesFederation(options: FederationOptions): Federation {
  const apiUrl = options.apiUrl ?? process.env['LANES_API_URL'] ?? DEFAULT_API_URL;
  const webUrl = options.webUrl ?? process.env['LANES_WEB_URL'] ?? DEFAULT_WEB_URL;

  const verifier = new AssertionVerifier({
    jwksUrl: `${apiUrl}/.well-known/jwks.json`,
    // The API is the issuer of the assertion, and the audience is *us*. Getting
    // these the wrong way round is the mistake that makes both checks
    // decorative, so they are named rather than positional.
    issuer: apiUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    consentUrl: `${webUrl}/link/authorize`,
    verify: (assertion, expected) => verifier.verify(assertion, expected),
    profilesFor: options.profilesFor,
  };
}
