import {
  IssuedTokenAuthenticator,
  OAuthServer,
  OAuthStore,
  OidcAuthenticator,
  OidcVerifier,
  lanesFederation,
  type Authenticator,
} from '#auth';
import type { Logger } from '#connectivity';
import type { Runtime } from '#cli/runtime.ts';
import { MCP_PATH } from './index.ts';
import type { AuthorizationSurface } from './oauth.ts';

/**
 * Deciding how a remote client proves who it is.
 *
 * Its own file, away from the lifecycle in `endpoint.ts`, because the two
 * answer different questions and only one of them is interesting. Starting an
 * endpoint is bind, serve, reload, stop. This is which of three models the
 * profile declared — none, an issuer of its own, or somebody else's — and each
 * arm carries an argument that has to be read to be changed safely.
 */

/**
 * The remote-client gate, if this profile declares one.
 *
 * Endpoint-scoped rather than per profile, like the bearer token and for the
 * same reason (ADR-009): one URL serves every profile in the workspace, so
 * there is one place a client authorises and one set of tokens.
 *
 * Returns null when `auth.authorization` is absent, and everything downstream
 * treats null as "exactly as before" — no metadata published, no pointer on the
 * `401`, one authenticator instead of a chain.
 */
export async function openAuthorization(
  primary: Runtime,
  log: Logger,
  members: (subject: string) => Promise<readonly string[]>,
): Promise<{ surface: AuthorizationSurface; authenticator: Authenticator } | null> {
  const declared = primary.config.auth.authorization;
  if (!declared) return null;

  const profile = primary.resolution.profile;

  if (declared.mode === 'oidc') {
    const audience = await primary.credentials.get(declared.client_id_ref);
    if (!audience) {
      // Refuse rather than verify without an audience. A verifier that cannot
      // check who a token was issued for accepts every token the issuer minted
      // for anything, which is the failure this mode exists to prevent.
      throw new Error(
        `auth.authorization.client_id_ref names "${declared.client_id_ref}", which is not in ` +
          `this target's credential store. Store it with: lanes link secrets set ${declared.client_id_ref}`,
      );
    }

    const verifier = new OidcVerifier({
      issuer: declared.issuer,
      audience,
      allowedSubjects: declared.allowed_subjects,
      ...(declared.introspection_endpoint
        ? { introspectionEndpoint: declared.introspection_endpoint }
        : {}),
    });

    return {
      // The issuer is somebody else's origin, so it is a constant here rather
      // than derived from the request.
      surface: { issuer: () => declared.issuer, mcpPath: MCP_PATH, target: primary.target },
      authenticator: new OidcAuthenticator(verifier, profile),
    };
  }

  const store = new OAuthStore(primary.state.kv);

  const server = new OAuthServer({
    store,
    accessTokenTtlMs: declared.access_token_ttl_minutes * 60_000,
    // So a replayed refresh token leaves a line. It is refused rather than
    // acted on (ADR-035), and a refusal nobody can see is how a connector
    // losing its authorization came to need log forensics to explain.
    log,
    // Identity comes from lanes.sh, not from a credential pasted into a form on
    // this machine (ADR-062). What this endpoint decides is the half lanes.sh
    // cannot know: which of *its* profiles name that person.
    federation: lanesFederation({ profilesFor: members }),
  });

  return {
    surface: { server, issuer: (origin) => origin, mcpPath: MCP_PATH, target: primary.target },
    authenticator: new IssuedTokenAuthenticator(store, profile),
  };
}
