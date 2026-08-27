import { defineProvider, type ProviderManifest } from '#connectivity';
import {
  AUTH_METHODS,
  CONNECTOR_KINDS,
  type AuthMethod,
  type ConnectorKind,
  type CustomAnswers,
} from './spec.ts';
import { identityBlock, setupBlock } from './prompts.ts';
import { authBlock } from './credential.ts';
import { many, one, port } from './values.ts';

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
      `An ${connector} connector authenticates with a username and password. Every mail and DAV host ` +
        'that matters issues an app password and expects it over Basic; OAuth for these exists but is ' +
        'partner-gated with no published scopes, so declaring it would validate and then fail to ' +
        'authenticate.\n  Use --auth basic.',
    );
  }

  if (auth === 'strategy' && connector !== 'http') {
    throw new Error(
      `A strategy signs or negotiates an HTTP request, and a ${connector} connector does not make ` +
        'one it could sign.\n  Use --connector http.',
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

/**
 * `--header 'Name: value'`, repeated.
 *
 * `Authorization` is refused here as well as by `defineProvider`, because this
 * is where somebody is choosing: the credential comes from `auth`, and a
 * manifest setting both would leave which one is sent up to merge order.
 */
function headers(answers: CustomAnswers): Record<string, string> | undefined {
  const declared = many(answers, 'header');
  if (declared.length === 0) return undefined;

  const parsed: Record<string, string> = {};

  for (const entry of declared) {
    const split = entry.indexOf(':');
    if (split < 1) {
      throw new Error(`--header "${entry}" is not a header. Write it as "Name: value".`);
    }

    const name = entry.slice(0, split).trim();
    if (name.toLowerCase() === 'authorization') {
      throw new Error(
        'The credential is the auth block\'s, so --header cannot set Authorization — setting both ' +
          'would leave which one is sent up to merge order.\n' +
          '  Use --auth bearer (or api-key, or header with --auth-header) instead.',
      );
    }

    parsed[name] = entry.slice(split + 1).trim();
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

  const sent = headers(answers);

  if (kind === 'mcp') {
    return { kind, endpoint: one(answers, 'endpoint'), ...(sent ? { headers: sent } : {}) };
  }

  if (kind === 'http') {
    const include = many(answers, 'operations');
    return {
      kind,
      base_url: one(answers, 'base-url'),
      openapi: one(answers, 'openapi'),
      ...(include.length > 0 ? { operations: { include } } : {}),
      ...(sent ? { headers: sent } : {}),
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
