import { PASTED } from '#connectivity/auth/index.ts';
import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import { ok, progress } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { askForSetup } from './setup.ts';

/**
 * `--auth pasted_token`: a credential the operator already holds.
 *
 * The escape hatch, and it exists because the flow above can be refused by
 * somebody who is not in the room. A Slack workspace on Enterprise Grid
 * requires an admin to approve an app before it can authenticate anyone, so an
 * operator whose admin has not approved the Lanes app cannot connect at all —
 * while a user token from an app their workspace already trusts works
 * perfectly. Removing the paste would take Slack away from exactly the people
 * who have the least ability to do anything about it.
 *
 * Written in the blob shape the OAuth path writes, into the same ref, which is
 * what makes it cost nothing downstream: no refresh token means
 * `upstreamAccessToken` hands the stored value back untouched, and no
 * `expires_at` means nothing calls it stale. `auth.kind` stays `oauth` because
 * it describes what the vendor offers, not how this one connection was filled.
 */
export async function authorisePastedToken(input: {
  manifest: ProviderManifest;
  connectionId: string;
  credentials: SecretStore;
  prompter?: Prompter;
}): Promise<void> {
  const { manifest, connectionId, credentials } = input;
  const prompter = input.prompter ?? terminalPrompter;
  if (manifest.auth.kind !== 'oauth') return;

  const prompts = (manifest.setup?.prompts ?? []).filter((prompt) => prompt.scope === 'connection');
  if (prompts.length === 0) {
    throw new Error(
      `${manifest.name} has no pasted-credential path: it does not describe a token to ask you ` +
        'for. Authorise in a browser instead — drop --auth, or pass --auth oauth.',
    );
  }

  const ref = `${manifest.id}/${connectionId}`;
  const answers = await askForSetup(
    manifest,
    prompts,
    `Stored at ${ref}, in the credential store — never in config.`,
    prompter,
  );

  await credentials.set(
    ref,
    JSON.stringify({
      access_token: answers.get(prompts[0]!.key)!,
      token_type: 'Bearer',
      // What the token can do was decided wherever it was minted and cannot be
      // read back, so this records what was asked for and no more. The scope
      // gate the browser path runs has nothing to show here — recorded as a
      // weaker guarantee in security.md rather than papered over.
      scope: manifest.auth.scopes.join(' '),
      authorized_via: PASTED,
    }),
  );

  progress(ok('token stored'));
}
