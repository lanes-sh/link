import { auth } from '@modelcontextprotocol/client';
import { CredentialOAuthProvider } from '#connectivity/auth/index.ts';
import { MANAGED_TARGET } from '#profile';
import { openRuntime, openSecretStoreFor } from '#cli/runtime.ts';
import { WIDENS } from './authorise.ts';
import { beginAuthorization, completeAuthorization, type AuthFlowDeps } from './oauth.ts';
import { PROFILE_NAME, json, type Route } from './routing.ts';

/**
 * Connecting an account to a hosted workspace, in two requests.
 *
 * `./oauth.ts` has held the whole of this since it was written and nothing ever
 * called it: the persistence between the two legs, the verifier that has to
 * survive them, and the refusals. What was missing was the surface — no route
 * anywhere reached `beginAuthorization` or `completeAuthorization`, so a hosted
 * workspace could hold profiles and grants and never an account.
 *
 * **Two requests rather than one, because a server is not a CLI.**
 * `lanes link connect` blocks on a loopback listener and holds the PKCE
 * verifier on the stack. Here the browser leg and the callback are separate
 * HTTP requests that may not even reach the same instance, so what the CLI keeps
 * in memory is written down — and `./oauth.ts` is the whole of that difference.
 *
 * **The API drives both legs and the browser never comes here.** This service is
 * not on the internet (ADR-075). The API holds the session that binds a callback
 * to the person who asked for it, holds the broker client secrets, and is where
 * the vendor's redirect lands. What arrives here is "start one" and "here is the
 * code".
 *
 * **Both are `WIDENS`.** Authorising an account is the widest thing that can
 * happen to a workspace: everything granted the connection afterwards can reach
 * it. So admin, plus the `link:admin` scope, plus the profile's own
 * agent-management switch — the same three gates every other widening route
 * passes.
 */

/** Where the vendor sends the browser back. The API's route, never ours. */
function redirectUrlFrom(body: Record<string, unknown>): string | null {
  const value = body['redirectUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringFrom(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Everything one flow needs, opened against the profile it will be granted to.
 *
 * A profile rather than the workspace, because the credential store and the
 * registry are both reached through one — and because the connection is being
 * authorised *for* a profile, so opening any other would be opening the wrong
 * account's store.
 */
async function flowDeps(input: {
  readonly env: Record<string, string | undefined>;
  readonly root: string;
  readonly profile: string;
  readonly provider: string;
}): Promise<{ deps: AuthFlowDeps; serverUrl: string } | { error: string; status: number }> {
  const runtime = await openRuntime(
    { profile: input.profile, target: MANAGED_TARGET, quiet: true },
    { env: input.env },
  );

  try {
    const manifest = runtime.registry.manifest(input.provider);
    if (!manifest) {
      return { error: `There is no provider called "${input.provider}".`, status: 404 };
    }
    if (manifest.auth.kind !== 'oauth') {
      // The paste-flow providers do not come through here: there is no
      // authorization server to redirect to. The API takes the value on a form
      // of its own and posts it to `POST /v1/connections`, so the secret is
      // never in an agent's context either way.
      return {
        error:
          `"${input.provider}" does not authorise through a browser. Its credential is ` +
          'entered directly, and Lanes takes it on a form rather than through this flow.',
        status: 409,
      };
    }

    // Where the flow authorises against. An MCP connector advertises its own
    // authorization server; a REST API names one in the manifest, because it
    // never announces one (ADR-040).
    const serverUrl =
      manifest.connector.kind === 'mcp' ? manifest.connector.endpoint : manifest.auth.authorize_url;
    if (!serverUrl) {
      return { error: `"${input.provider}" declares no authorization server.`, status: 409 };
    }

    const credentials = await openSecretStoreFor(input.root, MANAGED_TARGET);

    return {
      serverUrl,
      deps: {
        kv: runtime.state.kv,
        // The SDK's own `auth()`, which does discovery, registration and the
        // exchange. Injected rather than imported inside `oauth.ts` so that
        // file can be tested without an authorization server.
        runAuth: (provider, options) => auth(provider as never, options as never) as never,
        buildProvider: ({ connectionId, redirectUrl, state, openBrowser }) =>
          new CredentialOAuthProvider({
            manifest,
            connectionId,
            credentials,
            scopes: manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [],
            redirectUrl,
            openBrowser,
            state,
          }),
      },
    };
  } finally {
    // The flow's own state is written to the workspace, not held here, so the
    // runtime has nothing left to do once the deps are built. Closing it keeps
    // a connect from pinning a store for the length of a browser round trip.
    await runtime.close();
  }
}

export const CONNECT_ROUTES: readonly Route[] = [
  {
    method: 'POST',
    path: '/v1/connections/:provider/authorize',
    needs: WIDENS,
    async run({ params, root, env, body }) {
      const provider = params['provider'] ?? '';

      let given: Record<string, unknown>;
      try {
        given = ((await body()) ?? {}) as Record<string, unknown>;
      } catch {
        return json({ error: 'That request body is not JSON.' }, 400);
      }

      const profile = stringFrom(given, 'profile');
      const state = stringFrom(given, 'state');
      const redirectUrl = redirectUrlFrom(given);
      const connectionId = stringFrom(given, 'connectionId') ?? 'con1';

      if (!profile || !PROFILE_NAME.test(profile)) {
        return json({ error: 'A connect needs the profile it will be granted to.' }, 400);
      }
      if (!state || !redirectUrl) {
        // Both are the API's to mint: the state binds this flow to the person
        // who asked, and the redirect is where their browser comes back to.
        // Inventing either here would put the binding in the wrong service.
        return json({ error: 'A connect needs a state and a redirect URL.' }, 400);
      }

      const built = await flowDeps({ env, root, profile, provider });
      if ('error' in built) return json({ error: built.error }, built.status);

      try {
        const { url } = await beginAuthorization(
          { provider, connectionId, serverUrl: built.serverUrl, redirectUrl, state },
          built.deps,
        );
        return json({ url }, 200);
      } catch (error) {
        // The vendor's own refusal, or a connection that already holds a
        // credential. Both are the caller's to act on and neither is ours.
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    },
  },
  {
    method: 'POST',
    path: '/v1/connections/:provider/exchange',
    needs: WIDENS,
    async run({ params, root, env, body }) {
      const provider = params['provider'] ?? '';

      let given: Record<string, unknown>;
      try {
        given = ((await body()) ?? {}) as Record<string, unknown>;
      } catch {
        return json({ error: 'That request body is not JSON.' }, 400);
      }

      const profile = stringFrom(given, 'profile');
      const state = stringFrom(given, 'state');
      const code = stringFrom(given, 'code');
      const redirectUrl = redirectUrlFrom(given);
      const connectionId = stringFrom(given, 'connectionId') ?? 'con1';

      if (!profile || !state || !code || !redirectUrl) {
        return json({ error: 'An exchange needs a profile, a state, a code and a redirect.' }, 400);
      }

      const built = await flowDeps({ env, root, profile, provider });
      if ('error' in built) return json({ error: built.error }, built.status);

      try {
        const authorised = await completeAuthorization(
          { provider, connectionId, serverUrl: built.serverUrl, redirectUrl, state, code },
          built.deps,
        );
        // False rather than a throw means the SDK completed without ending up
        // authorised, which is a vendor answering oddly rather than a fault
        // here. Reported as a refusal so the caller sees something true.
        return authorised
          ? json({ provider, connectionId, authorised: true }, 200)
          : json({ error: 'The vendor did not authorise that exchange.' }, 409);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    },
  },
];
