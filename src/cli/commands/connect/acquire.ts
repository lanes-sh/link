import type { ConfigDocument } from '../../config-edit.ts';
import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import type { Prompter } from '../../prompt.ts';
import { authorise } from './authorise.ts';
import { authoriseWithKey } from './assertion.ts';
import { authorisePastedToken } from './pasted-token.ts';
import { ensureStaticCredential } from './setup.ts';
import type { ChosenMethod } from './method.ts';

/**
 * Getting the credential, whichever way this provider offers.
 *
 * Four routes and exactly one of them runs: a signed assertion from a key the
 * operator holds, a token they paste, a browser round trip, or a static
 * credential asked for and stored. `none` is the fifth case and does nothing —
 * an `fs` provider has no account to prove.
 *
 * Its own file because it is the one part of `runConnect` that is a decision
 * rather than a sequence, and because that file was at the size budget. Each arm
 * already lives in a module of its own; this is only the choosing.
 */
export async function acquireCredential(input: {
  readonly method: ChosenMethod;
  readonly manifest: ProviderManifest;
  readonly provisionalId: string;
  readonly credentials: SecretStore;
  readonly document: ConfigDocument;
  readonly changes: string[];
  readonly providerId: string;
  readonly connections: readonly { readonly provider: string }[];
  /** How the operator spelled the target, so a refusal names a command they typed. */
  readonly target: string | undefined;
  readonly profile: string;
  readonly prompter: Prompter;
  /** True when a name was given, which reads as "that one again". */
  readonly named: boolean;
  /** The connection id is still the placeholder, so nothing has been settled. */
  readonly provisional: boolean;
  readonly replace: boolean;
  readonly nonInteractive: boolean;
  readonly acceptBroadScopes: boolean;
  readonly fetch?: typeof globalThis.fetch | undefined;
}): Promise<void> {
  const { manifest, method, provisionalId, prompter, changes, document } = input;
  const { credentials, providerId, target, profile } = input;

  /**
   * "That one again", which is what asks for a value the store already has.
   *
   * Naming a connection says it, and so does `--replace`. Never
   * non-interactively: there, again has already happened — the new value was
   * written with `secrets set` before this ran, so asking would be asking for
   * something the store is holding.
   */
  const askAgain = !input.nonInteractive && (input.replace || input.named);

  if (method.kind === 'assertion') {
    await authoriseWithKey({
      manifest,
      assertion: method.assertion,
      connectionId: provisionalId,
      credentials,
      changes,
      replace: askAgain,
      prompter,
    });
  } else if (method.kind === 'pasted') {
    await authorisePastedToken({
      manifest,
      connectionId: provisionalId,
      credentials,
      prompter,
    });
  } else if (manifest.auth.kind === 'oauth') {
    await authorise({
      manifest,
      connectionId: provisionalId,
      credentials,
      document,
      changes,
      firstForProvider: !input.connections.some((c) => c.provider === providerId),
      ...(target === undefined ? {} : { target }),
      profile,
      client: method.client,
      prompter,
      acceptBroadScopes: input.acceptBroadScopes,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
  } else if (manifest.auth.kind !== 'none') {
    await ensureStaticCredential({
      manifest,
      connectionId: provisionalId,
      credentials,
      replace: askAgain,
      provisional: input.provisional,
      prompter,
    });
  }
}
