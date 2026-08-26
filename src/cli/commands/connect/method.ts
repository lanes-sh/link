import { credentialRefForConnection, type AuthAssertion, type ProviderManifest } from '#connectivity';
import { BROKERED, storedAssertionFor } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import { progress, style } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';

/**
 * Which way in, where a provider offers more than one.
 *
 * Two questions that used to be asked in two different places and are one
 * question to the person answering: what kind of credential, and — for the
 * browser — whose OAuth client. The second was a flag, `--own-client`, which is
 * to say it was a choice nobody discovered unless they already knew it existed.
 *
 * Most providers offer exactly one route and this file is inert for them:
 * `options` returns a single entry, nothing is printed, and nothing is asked.
 * That is the property worth protecting — adding routes to Google must not put
 * a question in front of somebody connecting GitHub.
 */

export type ChosenMethod =
  | { readonly kind: 'assertion'; readonly assertion: AuthAssertion }
  /**
   * The browser, and which client the exchange runs through.
   *
   * `undefined` means "whatever this profile already decided", which is the
   * precedence `resolveOAuthClient` has always applied: a declared `oauth_apps`
   * entry wins, otherwise the broker. It is what a provider with only one
   * browser route resolves to, so nothing about those changes.
   */
  | { readonly kind: 'oauth'; readonly client: 'own' | 'hosted' | undefined };

/** What this connection authenticates with today, at the granularity the prompt offers. */
export type CurrentMethod = 'assertion' | 'own' | 'hosted';

interface Option {
  /** What `--auth` accepts, and how a chosen route is named back. */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly chosen: ChosenMethod;
  readonly matches: CurrentMethod | undefined;
}

/**
 * A provider that can be reached with a client of the operator's own.
 *
 * `defineProvider` permits a broker with no client prompts — a provider with no
 * bring-your-own path is a legal thing to be — so offering that route without
 * checking would offer a choice with nothing behind it.
 */
function hasClientPrompts(manifest: ProviderManifest): boolean {
  return (manifest.setup?.prompts ?? []).some((prompt) => prompt.scope === 'shared');
}

/**
 * Every route this provider actually has, in the order they are offered.
 *
 * The key first, because it is the one that removes a recurring chore and the
 * one nobody would guess at. Then the hosted client, which is the default and
 * the thing "as it works today" means. Then a client of your own, which is
 * twenty minutes in a console and is what an organisation forbidding
 * third-party clients needs.
 */
export function options(manifest: ProviderManifest): readonly Option[] {
  if (manifest.auth.kind !== 'oauth') return [];

  const { assertion, broker } = manifest.auth;
  const found: Option[] = [];

  if (assertion) {
    found.push({
      id: assertion.method,
      label: assertion.label,
      detail: assertion.reach,
      chosen: { kind: 'assertion', assertion },
      matches: 'assertion',
    });
  }

  if (broker) {
    found.push({
      id: 'hosted_client',
      label: `Sign in through a browser, using the OAuth client ${broker.operator} operates`,
      detail:
        'nothing to register and no client secret on this machine. The exchange is performed by ' +
        `${broker.operator}, and the connection is re-authorised whenever its token expires.`,
      chosen: { kind: 'oauth', client: 'hosted' },
      matches: 'hosted',
    });
  }

  if (!broker || hasClientPrompts(manifest)) {
    found.push({
      id: 'own_client',
      label: 'Sign in through a browser, using an OAuth client you register',
      detail: broker
        ? 'a console walkthrough once per profile, after which nothing leaves this machine but ' +
          'the browser. What an organisation that forbids third-party clients needs.'
        : 'the whole account, and the connection is re-authorised whenever its token expires.',
      // Undefined rather than 'own' where it is the only browser route: there
      // is nothing to override, and forcing it would write an `oauth_apps`
      // entry for a provider whose manifest already says it is the only way.
      chosen: { kind: 'oauth', client: broker ? 'own' : undefined },
      matches: 'own',
    });
  }

  return found;
}

/** What `--auth` will accept for this provider, for a message that lists them. */
export function methodsFor(manifest: ProviderManifest): readonly string[] {
  return options(manifest).map((option) => option.id);
}

/**
 * What this connection authenticates with today, or nothing if it is new.
 *
 * Read from the credential rather than from config, because the credential is
 * where the answer lives: the routes share one ref and are told apart by what
 * is in it. Asking config instead would be a second record of the same fact,
 * free to disagree with the one that actually routes.
 *
 * `authorized_via` is stamped at connect for the same reason it is read at
 * refresh — a refresh token minted by one client is refused by another, so
 * which client issued this is a property of the token and not of the profile.
 */
export async function currentAuthMethod(
  manifest: ProviderManifest,
  connectionId: string,
  credentials: SecretStore,
): Promise<CurrentMethod | undefined> {
  const ref = credentialRefForConnection(manifest, connectionId);
  if (!ref) return undefined;

  const raw = await credentials.get(ref);
  if (!raw) return undefined;

  if (await storedAssertionFor(manifest, connectionId, credentials)) return 'assertion';

  try {
    return (JSON.parse(raw) as { authorized_via?: string }).authorized_via === BROKERED
      ? 'hosted'
      : 'own';
  } catch {
    return 'own';
  }
}

/**
 * Choose, from the flag, the operator, or the status quo — in that order.
 *
 * `current` is the default rather than a mere hint. Re-running `connect` on an
 * existing account is a repair nine times in ten, and a prompt whose default
 * silently swapped the route would turn a stale-token fix into a
 * re-authorisation nobody asked for — with the old credential overwritten by
 * the time they noticed.
 */
export async function chooseAuthMethod(input: {
  readonly manifest: ProviderManifest;
  /** `--auth <method>`, if it was given. */
  readonly requested: string | undefined;
  /** `--own-client`, which is the older spelling of one of these. */
  readonly ownClient?: boolean;
  /** What this connection authenticates with today, where it already exists. */
  readonly current: CurrentMethod | undefined;
  readonly prompter?: Prompter;
}): Promise<ChosenMethod> {
  const { manifest, requested } = input;
  const prompter = input.prompter ?? terminalPrompter;
  const available = options(manifest);

  if (requested !== undefined) {
    // `oauth` is not an option id. It is the older, coarser spelling — "the
    // browser, however this profile already resolves it" — and dropping it
    // would break a scripted `--auth oauth` for no gain.
    if (requested === 'oauth') return { kind: 'oauth', client: undefined };

    const picked = available.find((option) => option.id === requested);
    if (picked) return picked.chosen;

    throw new Error(
      `${manifest.name} cannot authenticate with "${requested}". ` +
        `--auth accepts: ${['oauth', ...methodsFor(manifest)].join(', ')}.`,
    );
  }

  if (input.ownClient === true) return { kind: 'oauth', client: 'own' };

  // One route, or none this file knows about: decide nothing and say nothing.
  if (available.length < 2) return { kind: 'oauth', client: undefined };

  // Nobody to ask. The flag above is the non-interactive answer, deliberately —
  // guessing picks which credential gets overwritten.
  if (!prompter.interactive) {
    const held = available.find((option) => option.matches === input.current);
    return held ? held.chosen : { kind: 'oauth', client: undefined };
  }

  return ask(manifest, available, input.current, prompter);
}

async function ask(
  manifest: ProviderManifest,
  available: readonly Option[],
  current: CurrentMethod | undefined,
  prompter: Prompter,
): Promise<ChosenMethod> {
  const held = available.findIndex((option) => option.matches === current);
  // "As it works today" for anyone who has not chosen otherwise: the hosted
  // client where there is one, and otherwise the browser. Never the key — it is
  // listed first because it is the one worth knowing about, and defaulting to
  // the first entry would make Enter mean "the route with a console visit in
  // it" for someone who was not reading.
  const hosted = available.findIndex((option) => option.id === 'hosted_client');
  const fallback =
    hosted !== -1 ? hosted : Math.max(available.findIndex((option) => option.chosen.kind === 'oauth'), 0);
  const preferred = String((held === -1 ? fallback : held) + 1);

  progress();
  progress(style.bold(`${manifest.name} can authenticate ${count(available.length)} ways`));
  progress();
  for (const [index, option] of available.entries()) {
    progress(`  ${index + 1}. ${option.label}`);
    progress(style.dim(`     ${option.detail}`));
  }
  if (held !== -1) {
    progress();
    progress(style.dim(`  This connection uses ${held + 1} today.`));
  }
  progress();

  const answer = await prompter.ask(`  Which ${style.dim(`[${preferred}]`)}`);
  const picked = answer.length === 0 ? preferred : answer;

  const byNumber = available[Number(picked) - 1];
  if (/^\d+$/.test(picked) && byNumber) return byNumber.chosen;

  const byName = available.find((option) => option.id === picked);
  if (byName) return byName.chosen;

  throw new Error(
    `"${picked}" is not one of the choices. Answer 1 to ${available.length}.`,
  );
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];
const count = (total: number): string => WORDS[total] ?? String(total);
