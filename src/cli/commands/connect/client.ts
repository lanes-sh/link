import {
  BROKER_ORIGIN_ENV,
  BrokerError,
  brokerConfig,
  brokerOriginOverride,
  type BrokerConfig,
} from '#connectivity/auth/index.ts';
import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import { ConfigDocument } from '../../config-edit.ts';
import { progress, style, warn } from '../../output.ts';
import type { Prompter } from '../../prompt.ts';
import { shortScope } from '../../scopes.ts';
import { declareOwnClient, ensureOAuthApp } from './setup.ts';

/**
 * Which OAuth client this authorisation uses, and whether it can be used.
 *
 * Two arrangements, and the manifest does not pick between them — the profile
 * does. Declaring an `oauth_apps` entry means "I registered a client, use it";
 * leaving it out means "use the one the broker operates". So a profile that has
 * already taken the trouble to register one is never moved off it, and everyone
 * else gets the path with no console in it.
 *
 * Everything here happens *before the browser opens*. A refusal after consent
 * has been given is a refusal the operator has already paid for, so the
 * checks that can be made early are made early.
 */

export type OAuthClient =
  | { readonly kind: 'own'; readonly clientId: string; readonly clientSecret: string }
  | { readonly kind: 'brokered'; readonly url: string; readonly config: BrokerConfig };

export interface ClientChoice {
  readonly manifest: ProviderManifest;
  readonly credentials: SecretStore;
  readonly document: ConfigDocument;
  readonly changes: string[];
  /** No connection of this provider exists yet, so its console setup is undone. */
  readonly firstForProvider: boolean;
  /** `--own-client`: register one rather than using the client the broker runs. */
  readonly ownClient: boolean;
  /** How the operator spelled the target, so a refusal names a command they typed. */
  readonly target: string;
  readonly profile: string;
  readonly prompter?: Prompter | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export async function resolveOAuthClient(input: ClientChoice): Promise<OAuthClient> {
  const { manifest, credentials, document } = input;
  if (manifest.auth.kind !== 'oauth') {
    throw new Error(`Provider "${manifest.id}" does not use OAuth.`);
  }

  const { app, broker } = manifest.auth;

  if (!broker || (await profileHasOwnClient(app, document, credentials)) || input.ownClient) {
    if (input.ownClient && broker && !hasClientPrompts(manifest)) {
      // `defineProvider` permits a broker with no prompts — a provider with no
      // bring-your-own path is a legal thing to be. This is where that absence
      // becomes a sentence rather than a prompt for a value nothing collects.
      throw new Error(
        `${manifest.name} has no bring-your-own client path: it does not describe what to ` +
          `register. Drop --own-client to authorise against the client ${broker.operator} operates.`,
      );
    }
    await ensureOAuthApp({
      manifest,
      credentials,
      document,
      changes: input.changes,
      firstForProvider: input.firstForProvider,
      ...(input.prompter ? { prompter: input.prompter } : {}),
    });
    if (input.ownClient) declareOwnClient(document, manifest, input.changes);

    const [clientId, clientSecret] = app
      ? await Promise.all([
          credentials.get(`${app}/client_id`),
          credentials.get(`${app}/client_secret`),
        ])
      : [null, null];

    if (!clientId || !clientSecret) {
      throw new Error(
        `No OAuth client stored for "${app}". Run: lanes link connect ${manifest.id}`,
      );
    }
    return { kind: 'own', clientId, clientSecret };
  }

  // Before the fetch, so it is said even when the broker cannot be reached.
  // The danger is not someone who set this deliberately; it is the variable
  // still exported in a shell three days later, quietly sending a real
  // authorization code somewhere other than where the operator believes.
  const overridden = brokerOriginOverride();
  if (overridden) {
    progress(
      warn(
        `${BROKER_ORIGIN_ENV} is set — the authorization code will be exchanged at ${overridden}, ` +
          `not by ${broker.operator}.`,
      ),
    );
  }

  let config: BrokerConfig;
  try {
    config = await brokerConfig(broker.url, input.fetch ?? globalThis.fetch);
  } catch (cause) {
    throw hostedClientRefusal({
      manifest,
      target: input.target,
      profile: input.profile,
      operator: broker.operator,
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof BrokerError && cause.notice ? { notice: cause.notice } : {}),
      docsUrl: broker.docs_url,
    });
  }

  if (!config.open) {
    throw hostedClientRefusal({
      manifest,
      target: input.target,
      profile: input.profile,
      operator: broker.operator,
      cause: 'it is not accepting new connections.',
      ...(config.notice ? { notice: config.notice } : {}),
      docsUrl: config.docsUrl ?? broker.docs_url,
    });
  }

  const { unsupported } = brokeredScopes(manifest.auth.scopes, config);
  if (unsupported.length > 0) {
    throw hostedClientRefusal({
      manifest,
      target: input.target,
      profile: input.profile,
      operator: broker.operator,
      cause:
        `it is not registered for ${unsupported.length === 1 ? 'a scope' : `${unsupported.length} scopes`} ` +
        `${manifest.name} needs:\n      ${unsupported.map(shortScope).join('\n      ')}`,
      docsUrl: config.docsUrl ?? broker.docs_url,
    });
  }

  if (config.capacity && config.capacity.cap > 0) {
    const left = config.capacity.cap - config.capacity.accounts;
    // Advisory, never a refusal. The vendor is the authority on its own cap and
    // still admits accounts that have already granted once, so refusing here
    // would lock out exactly the people it would still let through.
    if (left <= 10) {
      // `warn` formats; `progress` is what puts it on the stream. Called bare it
      // builds the sentence and drops it, which is how this one went unsaid.
      progress(
        warn(
          `The ${broker.operator} client is near capacity (${config.capacity.accounts} of ${config.capacity.cap} accounts).`,
        ),
      );
    }
  }

  progress(
    style.dim(
      `Authorising against the OAuth client ${broker.operator} operates — nothing to register.`,
    ),
  );

  return { kind: 'brokered', url: broker.url, config };
}

/**
 * Whether this profile holds a client of its own.
 *
 * The config entry is the declaration, but the store is consulted too: someone
 * who placed the two values by hand and whose config lost the block keeps their
 * client rather than being quietly moved onto a different one, where every
 * existing refresh token would stop working.
 */
async function profileHasOwnClient(
  app: string | undefined,
  document: ConfigDocument,
  credentials: SecretStore,
): Promise<boolean> {
  if (!app) return false;
  if (document.getIn(['oauth_apps', app]) !== undefined) return true;

  const [id, secret] = await Promise.all([
    credentials.get(`${app}/client_id`),
    credentials.get(`${app}/client_secret`),
  ]);
  return Boolean(id && secret);
}

function hasClientPrompts(manifest: ProviderManifest): boolean {
  return (manifest.setup?.prompts ?? []).some((prompt) => prompt.scope === 'shared');
}

/**
 * What is actually asked for, and what the broker cannot grant.
 *
 * The identity scopes are appended rather than assumed: they are what lets the
 * broker tell one caller's refresh from another's, and the broker says which
 * ones it wants so it can change them without a new CLI. They are added *only*
 * on this path — for a client the operator registered there is nobody to
 * identify to, and asking would cost them a re-consent and two extra lines in
 * their own console for no benefit at all.
 */
export function brokeredScopes(
  wanted: readonly string[],
  config: BrokerConfig,
): { readonly scopes: readonly string[]; readonly unsupported: readonly string[] } {
  // An empty `scopes_supported` means the broker did not say, not that it
  // supports nothing. Treating silence as refusal would break every connection
  // against a broker that simply does not advertise.
  const unsupported =
    config.scopesSupported.length > 0
      ? wanted.filter((scope) => !config.scopesSupported.includes(scope))
      : [];

  const scopes = [...wanted];
  for (const scope of config.identityScopes) if (!scopes.includes(scope)) scopes.push(scope);

  return { scopes, unsupported };
}

/** The refusal that names the way out, with the command already filled in. */
export function hostedClientRefusal(input: {
  manifest: ProviderManifest;
  target: string;
  profile: string;
  operator: string;
  cause: string;
  notice?: string | undefined;
  docsUrl?: string | undefined;
  /** Consent has already been given, so say so before saying nothing was kept. */
  afterConsent?: boolean | undefined;
  /**
   * Whether registering a client of your own is the way past this.
   *
   * The broker knows and this does not: a spent capacity and a replayed
   * authorization code are both a 4xx, and offering an hour in a cloud console
   * as the fix for the second is worse than offering nothing. Defaults to true
   * because the refusals raised before the browser opens are all of the first
   * kind — a broker that is closed, unreachable, or short a scope.
   */
  ownClient?: boolean | undefined;
}): Error {
  const lines = [
    `${input.manifest.name} could not be authorised against the OAuth client ${input.operator} operates.`,
    '',
  ];

  if (input.afterConsent) {
    lines.push(
      '  You approved the consent screen, but the token exchange was refused, so nothing',
      '  was stored.',
      '',
    );
  }

  // The reason is the broker's to word, so a spent capacity, a suspension and a
  // maintenance window can read differently without shipping a new CLI.
  lines.push(`  ${input.notice ?? input.cause}`, '');
  if (input.notice) lines.push(`  (${input.cause})`, '');

  lines.push('  Nothing was written and no account was connected.');

  if (input.ownClient !== false) {
    lines.push(
      '',
      '  Register your own OAuth client instead:',
      `    lanes link connect ${input.target} --profile ${input.profile} --own-client`,
      '',
      '  That walks through the vendor’s console once and then covers every account on',
      '  this profile.',
    );
  }

  if (input.docsUrl) lines.push(`  ${input.docsUrl}`);

  return new Error(lines.join('\n'));
}
