import { AUTH_KIND, type CustomAnswers } from './spec.ts';
import { many, one, pairs } from './values.ts';

/**
 * The credential block, and the OAuth rules the schema does not carry.
 *
 * Split from `derive.ts` because it fails for a different reason. That file is
 * about a connectivity type's fields, which are either given or defaulted; this
 * one is about arrangements that *validate* and then cannot run — an
 * authorization server with nowhere to send the browser, a client nobody
 * registered, a header the transport will not read. Each of those surfaces after
 * a credential has been stored or a consent screen approved, so each is refused
 * here.
 */

export function authBlock(answers: CustomAnswers): Record<string, unknown> {
  const method = answers.auth;
  const kind = AUTH_KIND[method];
  const header = one(answers, 'auth-header');
  const query = one(answers, 'auth-query');

  if (method === 'none' || method === 'basic') return { kind };

  if (method === 'bearer') {
    if (header && answers.connector === 'mcp') {
      throw new Error(
        'An mcp connector always sends its token as "Authorization: Bearer", so --auth-header ' +
          `("${header}") could not be honoured — the transport never reads the resolved credential, ` +
          'only the token, and the header would be dropped in silence.\n' +
          '  Drop the flag, or reach this service with --connector http.',
      );
    }
    return { kind, ...(header ? { header } : {}) };
  }

  if (method === 'header') {
    if (query) {
      throw new Error(
        '--auth-query is only meaningful for --auth api-key, which may put its key in the query ' +
          'string. A "header" credential is sent in a header of its own and nothing forwards a query ' +
          'parameter, so this would be dropped in silence.',
      );
    }
    return { kind, header };
  }

  if (method === 'strategy') {
    // Whether the name resolves is the registry's to answer, not this file's: a
    // strategy travels on a provider's definition, and `strategyFor` looks first
    // at this manifest's own and then at every other registered provider's.
    // `refuseStrategy` is what says a name reaches nothing, and it can list what
    // does — which is why this does not try to.
    const named = one(answers, 'strategy');
    const options = pairs(answers, 'strategy-option');

    return {
      kind,
      strategy: named,
      ...(options ? { options } : {}),
    };
  }

  if (method === 'api-key') {
    if (header && query) {
      throw new Error(
        '--auth-header and --auth-query contradict: a key goes in a header or in the query string, ' +
          'and declaring both leaves which one is sent up to whichever the transport reads last.',
      );
    }
    return { kind, ...(header ? { header } : {}), ...(query ? { query } : {}) };
  }

  return oauthBlock(answers);
}

/**
 * The one credential type with rules the schema does not carry.
 *
 * Each of these produces a manifest `defineProvider` accepts and `authorise`
 * cannot run, which is worse than an invalid one: the operator finds out after
 * approving a consent screen, or not until the first call.
 */
function oauthBlock(answers: CustomAnswers): Record<string, unknown> {
  const scopes = many(answers, 'scopes');
  const authorizeUrl = one(answers, 'authorize-url');
  const tokenUrl = one(answers, 'token-url');
  const app = one(answers, 'client-app');
  const declared = one(answers, 'registration');
  const redirect = one(answers, 'redirect-uri');
  const authorizeParams = pairs(answers, 'authorize-param');

  if (Boolean(authorizeUrl) !== Boolean(tokenUrl)) {
    throw new Error(
      'OAuth endpoints are declared together or not at all. `authorise` takes the direct path only ' +
        'when both are present, so half a pair is ignored on an mcp connector and fatal on an http ' +
        'one.\n  Add the missing one of --authorize-url / --token-url, or drop both.',
    );
  }

  // A REST API has no MCP metadata document to discover from, so a client has
  // to come from somewhere the manifest names.
  const registration =
    declared ?? (answers.connector === 'mcp' && !authorizeUrl && !app ? 'dynamic' : 'manual');

  if (registration === 'dynamic' && answers.connector === 'http') {
    throw new Error(
      'Dynamic client registration is something an authorization server offers, and a REST API ' +
        'publishes no registration endpoint — there would be no client to authorise with.\n' +
        '  Register a client with the vendor and drop --registration, which then defaults to manual.',
    );
  }

  if (registration === 'dynamic' && authorizeUrl) {
    throw new Error(
      'Declaring both endpoints is what takes an mcp connector off the SDK\'s own OAuth path and onto ' +
        'ours, and ours needs a client to present (ADR-040). Registration cannot be dynamic there.\n' +
        '  Drop --registration dynamic, or drop the two endpoint URLs and let the SDK register.',
    );
  }

  if (registration === 'manual' && answers.connector === 'http' && !authorizeUrl) {
    throw new Error(
      'An http connector has no metadata document to discover an authorization server from: a REST ' +
        'API is a base URL, and where consent happens is not something it announces.\n' +
        '  Add --authorize-url and --token-url.',
    );
  }

  return {
    kind: 'oauth',
    registration,
    ...(registration === 'manual' ? { app: app ?? answers.id } : {}),
    scopes,
    ...(authorizeUrl ? { authorize_url: authorizeUrl } : {}),
    ...(tokenUrl ? { token_url: tokenUrl } : {}),
    ...(redirect ? { redirect_uri: redirect } : {}),
    // Google needs `access_type=offline` and `prompt=consent`, without which it
    // returns an access token and no refresh token — so the connection works for
    // an hour and then dies, which is a miserable thing to debug. Any vendor can
    // have one of these, and nothing but the vendor's own docs will say so.
    ...(authorizeParams ? { authorize_params: authorizeParams } : {}),
  };
}
