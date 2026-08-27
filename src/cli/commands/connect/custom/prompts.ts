import type { CustomAnswers } from './spec.ts';

/**
 * What the manifest says about being connected: what to ask for, and how to
 * label the account it turns out to be.
 *
 * Neither is optional decoration. `ensureStaticCredential` throws for any
 * credential type that is asked for rather than granted and finds no
 * per-connection prompt, so a manifest without one is a provider that cannot be
 * connected at all. And without an `identity` block a connection list reads
 * `Thing main`, `Thing main2` — which cannot answer the only question anyone
 * asks of it, and leaves `connect` unable to tell a reconnect from a new
 * account.
 */

/** Where a per-account prompt's ref comes from, so it must not be declared. */
const PER_ACCOUNT = { scope: 'connection' } as const;

/**
 * The two prompt keys that are not ours to choose.
 *
 * `declareOwnClient` looks these up by literal key, and `resolveOAuthClient`
 * reads `<app>/client_id` and `<app>/client_secret` out of the credential store
 * by literal string. Spell either differently and the manifest validates,
 * `connect` collects two secrets from the operator, stores them, and *then*
 * refuses with "No OAuth client stored" — after they have been through a vendor
 * console. There is no freedom here and the tests assert it against
 * `declareOwnClient` rather than against a copy of these strings.
 */
const OAUTH_CLIENT_KEYS = ['client_id', 'client_secret'] as const;

export function setupBlock(answers: CustomAnswers): Record<string, unknown> | undefined {
  const prompts = promptsFor(answers);
  const docs = documentation(answers);

  if (prompts.length === 0 && Object.keys(docs).length === 0) return undefined;
  return { ...docs, ...(prompts.length > 0 ? { prompts } : {}) };
}

function promptsFor(answers: CustomAnswers): Record<string, unknown>[] {
  const { auth, name } = answers;

  if (auth === 'none') return [];

  if (auth === 'basic') {
    // Exactly one of each, in this order: `basic` stores `username:password` —
    // RFC 7617's own encoding — and cannot be assembled from anything else.
    return [
      { key: 'username', label: 'Username', ...PER_ACCOUNT, field: 'username' },
      { key: 'password', label: 'Password', secret: true, ...PER_ACCOUNT, field: 'password' },
    ];
  }

  if (auth === 'bearer') {
    return [{ key: 'token', label: `${name} API token`, secret: true, ...PER_ACCOUNT }];
  }

  if (auth === 'api-key' || auth === 'header') {
    return [{ key: 'api_key', label: `${name} API key`, secret: true, ...PER_ACCOUNT }];
  }

  // Dynamic registration asks for nothing: the authorization server hands out a
  // client and the operator never sees one.
  const app = clientApp(answers);
  if (!app) return [];

  return OAUTH_CLIENT_KEYS.map((key) => ({
    key,
    label: `${name} OAuth ${key.replace('_', ' ')}`,
    ...(key === 'client_secret' ? { secret: true } : {}),
    // Shared across every account of this profile, so the ref cannot derive
    // from a connection and has to be named.
    scope: 'shared',
    credential_ref: `${app}/${key}`,
  }));
}

/** The `oauth_apps` entry a manual client lands in, or nothing. */
function clientApp(answers: CustomAnswers): string | undefined {
  if (answers.auth !== 'oauth') return undefined;

  const declared = answers.values['registration'];
  const explicit = answers.values['client-app'];
  const endpoints = answers.values['authorize-url'];

  const dynamic =
    declared === 'dynamic' ||
    (declared === undefined && answers.connector === 'mcp' && !explicit && !endpoints);

  if (dynamic) return undefined;
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : answers.id;
}

/**
 * `--setup-docs`, placed by shape.
 *
 * Never into `setup.docs`, which nothing reads — `printSetup` renders `summary`,
 * `docs_url` and `steps`, and `planFor` reads `docs_url`. A manifest using
 * `docs` validates and then shows the operator nothing, which is the worst of
 * the three outcomes.
 */
function documentation(answers: CustomAnswers): Record<string, unknown> {
  const value = answers.values['setup-docs'];
  if (typeof value !== 'string' || value.length === 0) return {};

  if (!/^https?:\/\//i.test(value)) return { steps: [value] };

  const app = clientApp(answers);
  return {
    docs_url: value,
    // The one thing a vendor's console asks for that this command knows and the
    // operator cannot guess: the redirect URI is a loopback address on a port
    // chosen per run, so a fixed port registered there will not match.
    ...(app
      ? {
          steps: [
            `Register an OAuth client at ${value}. Its redirect URI is a loopback address — ` +
              'http://127.0.0.1/callback on a port chosen per run — so register whichever loopback ' +
              'form the vendor accepts.',
          ],
        }
      : {}),
  };
}

/**
 * How this provider will say whose account was authorised.
 *
 * Three transports implement `identify()` — imap, dav and fs — and for the first
 * two it is also the credential check, since the answer is the name the *server
 * accepted* rather than the one the operator typed. An mcp connector gets no
 * block: the identity would be a tool call, and a guessed tool name turns a
 * working connect into a failed probe. An http one gets a block only when both
 * halves were given, because a URL with no field to read is not an identity.
 */
export function identityBlock(answers: CustomAnswers): Record<string, unknown> | undefined {
  if (answers.connector === 'imap' || answers.connector === 'dav' || answers.connector === 'fs') {
    return { kind: 'connector' };
  }

  if (answers.connector !== 'http') return undefined;

  const url = answers.values['identity-url'];
  const field = answers.values['identity-field'];
  if (typeof url !== 'string' || url.length === 0) return undefined;

  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(
      '--identity-url needs --identity-field: the probe is one GET, and the field is which value in ' +
        'the response names the account. Without it there is nothing to read out of the body.',
    );
  }

  return { kind: 'http', url, field };
}
