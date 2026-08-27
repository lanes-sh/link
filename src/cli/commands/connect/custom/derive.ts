import { defineProvider, type ProviderManifest } from '#connectivity';
import {
  AUTH_KIND,
  AUTH_METHODS,
  CONNECTOR_KINDS,
  type AuthMethod,
  type ConnectorKind,
  type CustomAnswers,
} from './spec.ts';
import { identityBlock, setupBlock } from './prompts.ts';

/**
 * Turning what the operator said into a manifest.
 *
 * The flag surface cannot mirror the schema, because `defineProvider` demands
 * fields nobody should have to type: `setup.prompts` for every credential type
 * that is asked for rather than granted, an `identity` block wherever the
 * connector can answer, and — for a manual OAuth client — two prompt keys and
 * two credential refs whose exact spelling is read back by literal string
 * elsewhere. So this file derives them, and `defineProvider` still has the last
 * word, exactly as it does for a hand-written file.
 *
 * It also refuses three things the schema accepts and `authorise` cannot run.
 * That is the failure class worth the most care here: the manifest validates,
 * the connection is declared, and the flow has nowhere to go — which is
 * indistinguishable from a working setup right up until somebody uses it.
 */

export function parseConnectorKind(value: string): ConnectorKind {
  if ((CONNECTOR_KINDS as readonly string[]).includes(value)) return value as ConnectorKind;

  if (value === 'local') {
    throw new Error(
      '"local" is not a connectivity type you can declare: it means the capability code is ours, ' +
        'compiled into this build — the example provider and the owner layer. There is nothing for a ' +
        `manifest to point at. Pick one of: ${CONNECTOR_KINDS.join(', ')}.`,
    );
  }

  throw new Error(`Unknown connectivity type "${value}". Pick one of: ${CONNECTOR_KINDS.join(', ')}.`);
}

export function parseAuthMethod(value: string): AuthMethod {
  if ((AUTH_METHODS as readonly string[]).includes(value)) return value as AuthMethod;

  if (value === 'strategy') {
    throw new Error(
      '"strategy" is the escape hatch for authentication no declarative form should try to express — ' +
        'a keypair handshake, a signature over every request. It is per-vendor code in this ' +
        'repository and none is registered, so a manifest declaring one would authorise and then ' +
        'fail on every call. See docs/detailed/creating-a-provider.md.',
    );
  }

  throw new Error(`Unknown credential type "${value}". Pick one of: ${AUTH_METHODS.join(', ')}.`);
}

/**
 * Which pairs `defineProvider` would refuse, refused here instead.
 *
 * Same rules, earlier, and naming the alternative. The point is not to
 * duplicate the check — it runs regardless a moment later — but that its
 * message states a rule where this one states what to do about it.
 */
export function refuseIllegalPair(connector: ConnectorKind, auth: AuthMethod): void {
  if (connector === 'mcp' && auth !== 'none' && auth !== 'oauth' && auth !== 'bearer') {
    throw new Error(
      `An mcp connector sends exactly one header, "Authorization: Bearer", because that is what the ` +
        `MCP specification says a client sends. There is nowhere else on the request for a "${auth}" ` +
        'credential to go, so this would connect unauthenticated: no error, an empty tool list, and ' +
        'nothing to read that says why.\n' +
        '  Reach the same service over its REST API with --connector http, or use --auth bearer.',
    );
  }

  if ((connector === 'imap' || connector === 'dav') && auth !== 'basic') {
    throw new Error(
      `A ${connector} connector authenticates with a username and password. Every mail and DAV host ` +
        'that matters issues an app password and expects it over Basic; OAuth for these exists but is ' +
        'partner-gated with no published scopes, so declaring it would validate and then fail to ' +
        'authenticate.\n  Use --auth basic.',
    );
  }

  if (connector === 'fs' && auth !== 'none') {
    throw new Error(
      'An fs connector reads a folder on this machine and holds no account. The permission is the ' +
        'operating system\'s, held against this process — there is nothing to store and nothing that ' +
        'could be carried to another machine (ADR-011).\n  Use --auth none.',
    );
  }
}

/**
 * What gets written: only the fields the operator's answers actually settle.
 *
 * Deliberately *not* a `ProviderManifest`, and the distinction is load-bearing
 * twice over. `defineProvider` fills in every schema default, and writing those
 * back out would freeze them — a manifest saying `port: 993` no longer follows
 * the default if it ever changes, and a re-run diffs against a file full of
 * values nobody chose.
 *
 * Worse, it would not even load. Defaulting `auth.refresh_token` to `required`
 * puts a key ending in `_token` into the document, and the entropy check that
 * guards a manifest refuses any such key that is not a `_ref` — so the file this
 * command wrote would be rejected the next time anything read it. Rendering the
 * declaration rather than the validated manifest is what keeps the two honest.
 */
export function deriveDeclaration(answers: CustomAnswers): Record<string, unknown> {
  refuseIllegalPair(answers.connector, answers.auth);

  const setup = setupBlock(answers);
  const identity = identityBlock(answers);

  return {
    id: answers.id,
    name: answers.name,
    ...(answers.description ? { description: answers.description } : {}),
    connector: connectorBlock(answers),
    auth: authBlock(answers),
    ...(identity ? { identity } : {}),
    ...(setup ? { setup } : {}),
  };
}

/** The same declaration, validated — which is what a re-run compares against. */
export function deriveManifest(answers: CustomAnswers): ProviderManifest {
  return defineProvider(deriveDeclaration(answers));
}

const one = (answers: CustomAnswers, flag: string): string | undefined => {
  const value = answers.values[flag];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const many = (answers: CustomAnswers, flag: string): readonly string[] => {
  const value = answers.values[flag];
  return Array.isArray(value) ? value.filter((entry) => entry.length > 0) : [];
};

function port(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--${flag} must be a port between 1 and 65535, not "${value}".`);
  }
  return parsed;
}

/**
 * Only what was said, plus what cannot be defaulted.
 *
 * A schema default is deliberately not written: leaving `port` out means a
 * manifest follows the default if it ever changes, and it keeps the diff on a
 * re-run down to what actually differs.
 */
function connectorBlock(answers: CustomAnswers): Record<string, unknown> {
  const kind = answers.connector;

  if (kind === 'mcp') return { kind, endpoint: one(answers, 'endpoint') };

  if (kind === 'http') {
    const include = many(answers, 'operations');
    return {
      kind,
      base_url: one(answers, 'base-url'),
      openapi: one(answers, 'openapi'),
      ...(include.length > 0 ? { operations: { include } } : {}),
    };
  }

  if (kind === 'imap') {
    const smtpHost = one(answers, 'smtp-host');
    const smtpPort = port(one(answers, 'smtp-port'), 'smtp-port');

    return {
      kind,
      host: one(answers, 'host'),
      ...(port(one(answers, 'port'), 'port') !== undefined
        ? { port: port(one(answers, 'port'), 'port') }
        : {}),
      // No SMTP host, no send capability — `imap/index.ts` reads the absence of
      // the block, so a mailbox declared without one is read-only by
      // construction rather than by policy.
      ...(smtpHost
        ? {
            smtp: {
              host: smtpHost,
              ...(smtpPort !== undefined ? { port: smtpPort } : {}),
              // A consequence of the port rather than a separate question: 465
              // is implicit TLS, 587 upgrades in-band, and the default is the
              // latter. Written only when it is not the default.
              ...(smtpPort === 465 ? { starttls: false } : {}),
            },
          }
        : {}),
    };
  }

  if (kind === 'dav') {
    return { kind, base_url: one(answers, 'base-url'), service: one(answers, 'service') };
  }

  const exclude = many(answers, 'exclude');
  return {
    kind,
    root: one(answers, 'root'),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

function authBlock(answers: CustomAnswers): Record<string, unknown> {
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
  };
}
