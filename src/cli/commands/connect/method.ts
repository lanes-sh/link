import { hasOwnClientPath, type AuthAssertion, type ProviderManifest } from '#connectivity';
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
 * a question, or a warning, in front of somebody connecting GitHub.
 */

export type ChosenMethod =
  | {
      readonly kind: 'assertion';
      /** How `--auth` spells this route, for reporting what the connection became. */
      readonly id: string;
      readonly assertion: AuthAssertion;
    }
  /**
   * The browser, and which client the exchange runs through.
   *
   * `undefined` means "whatever this profile already decided", which is the
   * precedence `resolveOAuthClient` has always applied: a declared `oauth_apps`
   * entry wins, otherwise the broker. It is what a provider with only one
   * browser route resolves to, so nothing about those changes.
   *
   * `id` is unset for exactly those synthesised cases — `--auth oauth`,
   * `--own-client`, and a provider with one route — because there was no choice
   * to report. A provider that never offered two reads as it always did.
   */
  | { readonly kind: 'oauth'; readonly id?: string; readonly client: 'own' | 'hosted' | undefined }
  /**
   * A credential the operator already holds, for a provider that does OAuth.
   *
   * Offered where an OAuth manifest still declares a per-connection prompt,
   * which is a thing to be only where the browser route can be closed by
   * somebody who is not in the room: a Slack workspace on Enterprise Grid needs
   * an admin to approve an app before it can authenticate anyone, and the
   * person running `connect` may not be that admin.
   */
  | { readonly kind: 'pasted'; readonly id?: string };

interface Option {
  /** What `--auth` accepts, and how a chosen route is named back. */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly chosen: ChosenMethod;
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
      chosen: { kind: 'assertion', id: assertion.method, assertion },
    });
  }

  if (broker) {
    found.push({
      id: 'hosted_client',
      label: `Sign in through a browser, using the OAuth client ${broker.operator} operates`,
      detail:
        'nothing to register and no client secret on this machine. The exchange is performed by ' +
        `${broker.operator}, and the connection is re-authorised whenever its token expires.`,
      chosen: { kind: 'oauth', id: 'hosted_client', client: 'hosted' },
    });
  }

  if (!broker || hasOwnClientPath(manifest)) {
    found.push({
      id: 'own_client',
      label: 'Sign in through a browser, using an OAuth client you register',
      detail: broker
        ? 'a console walkthrough once per profile, after which nothing leaves this machine but ' +
          'the browser. What an organisation that forbids third-party clients needs.'
        : 'the whole account, and the connection is re-authorised whenever its token expires.',
      // Undefined `client` rather than 'own' where it is the only browser route:
      // there is nothing to override, and forcing it would write an `oauth_apps`
      // entry for a provider whose manifest already says it is the only way.
      chosen: { kind: 'oauth', id: 'own_client', client: broker ? 'own' : undefined },
    });
  }

  // Last, always. It is the way in when the others are refused, not one anyone
  // should be reaching for first: what it stores is the credential itself
  // rather than a means of obtaining one, so rotating it is manual, and nothing
  // can show what it is allowed to do.
  const pasted = (manifest.setup?.prompts ?? []).filter((prompt) => prompt.scope === 'connection');
  if (pasted.length > 0) {
    found.push({
      id: 'pasted_token',
      label: `Paste a ${pasted.map((prompt) => prompt.label).join(', then ')} you already hold`,
      detail:
        'no browser, for a workspace that has not approved this app — which an admin decides, ' +
        'not you. The credential is stored as given, so rotating it is manual and nothing can ' +
        'say what it is allowed to do.',
      chosen: { kind: 'pasted', id: 'pasted_token' },
    });
  }

  return found;
}

/** What `--auth` will accept for this provider, for a message that lists them. */
export function methodsFor(manifest: ProviderManifest): readonly string[] {
  return options(manifest).map((option) => option.id);
}

/**
 * Choose, from the flag or from the operator — and from nothing else.
 *
 * Nothing is inferred from what this account authenticates with today, which is
 * a decision rather than an omission. A connection authenticates one way at a
 * time: whichever route this run picks replaces the credential the account has
 * now, and re-running `connect` is how somebody switches. Defaulting to the
 * stored route would mean reading a credential to answer a question that is the
 * operator's on every run, and would hide the replacement behind a default that
 * reads as a no-op.
 *
 * It used to try. The route was read from the *provisional* connection id,
 * which is `pending` until identity is settled — so it found nothing every
 * time, fell back to the browser, and performed the silent swap it existed to
 * prevent on anyone who pressed Enter. Saying what the choice does is the part
 * that was actually missing.
 */
export async function chooseAuthMethod(input: {
  readonly manifest: ProviderManifest;
  /** `--auth <method>`, if it was given. */
  readonly requested: string | undefined;
  /** `--own-client`, which is the older spelling of one of these. */
  readonly ownClient?: boolean;
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
  // guessing picks which credential gets overwritten (ADR-038).
  if (!prompter.interactive) return { kind: 'oauth', client: undefined };

  return ask(manifest, available, prompter);
}

async function ask(
  manifest: ProviderManifest,
  available: readonly Option[],
  prompter: Prompter,
): Promise<ChosenMethod> {
  // "As it works today" for anyone who has not chosen otherwise: the hosted
  // client where there is one, and otherwise the browser. Never the key — it is
  // listed first because it is the one worth knowing about, and defaulting to
  // the first entry would make Enter mean "the route with a console visit in
  // it" for someone who was not reading.
  const hosted = available.findIndex((option) => option.id === 'hosted_client');
  const fallback =
    hosted !== -1 ? hosted : Math.max(available.findIndex((option) => option.chosen.kind === 'oauth'), 0);
  const preferred = String(fallback + 1);

  progress();
  progress(style.bold(`${manifest.name} can authenticate ${count(available.length)} ways`));
  progress();
  for (const [index, option] of available.entries()) {
    progress(`  ${index + 1}. ${option.label}`);
    progress(style.dim(`     ${option.detail}`));
  }
  progress();
  // Printed whether or not this account is already connected, because it is a
  // statement about what the command does rather than a reading of what is
  // stored — and on a first connect it is true with nothing to replace.
  progress(style.dim('  Whichever you pick becomes the only way in for this account. It replaces'));
  progress(
    style.dim('  whatever is stored for it now — a connection authenticates one way at a time.'),
  );
  progress();

  const answer = await prompter.ask(`Which ${style.dim(`[${preferred}]`)}`);
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
