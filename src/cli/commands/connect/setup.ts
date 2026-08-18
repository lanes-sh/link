import type { SecretStore } from '#secrets';
import type { ProviderManifest, SetupPrompt } from '#connectivity';
import { credentialRefForConnection } from '#connectivity';
import { ConfigDocument } from '../../config-edit.ts';
import { ok, progress, style } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';

/**
 * The console work a provider needs done, and the values it needs handed over.
 *
 * The only part of `connect` that talks to the operator about a vendor's own
 * setup — which is why the prompts live here and nowhere else.
 */

/**
 * Print a provider's setup block, asking for nothing.
 *
 * Separate from `askForSetup` because the instructions and the prompt have
 * different audiences. The prompt is needed once per profile — the OAuth client
 * is shared, so a second Google provider has nothing to be asked for. The
 * *instructions* are per product: each one names APIs to enable and scopes to
 * add under DATA ACCESS, and those are console work nobody has done yet.
 *
 * Bundled together, the second provider silently got neither. Connecting
 * `sheets` on a profile that already had Gmail skipped straight to the browser,
 * and the two ways that fails are the two this repository keeps warning about —
 * an unregistered scope is refused at consent, and a disabled API consents
 * cleanly and then 403s on every call.
 */
export function printSetup(manifest: ProviderManifest, note: string): void {
  const setup = manifest.setup;
  if (!setup) return;

  progress();
  progress(style.bold(`Setting up ${manifest.name}`));
  if (setup.summary) progress(setup.summary);
  if (setup.docs_url) progress(style.dim(setup.docs_url));
  progress();
  setup.steps.forEach((step, index) => progress(`  ${index + 1}. ${step}`));
  progress();
  progress(style.dim(note));
  progress();
}

/**
 * Render a provider's setup block, then ask for what it declares.
 *
 * Shared by the OAuth-client path and the static-credential path, because they
 * are the same conversation: show the operator where to generate something, then
 * take it and put it in the store. The only difference is where it lands, which
 * the caller decides.
 */
export async function askForSetup(
  manifest: ProviderManifest,
  prompts: readonly SetupPrompt[],
  note: string,
  prompter: Prompter = terminalPrompter,
): Promise<Map<string, string>> {
  const setup = manifest.setup;
  if (!setup) {
    throw new Error(
      `Provider "${manifest.id}" needs a credential but declares no setup, so there is no way to learn what to ask you for. Add a setup block to its manifest.`,
    );
  }

  printSetup(manifest, note);

  const answers = new Map<string, string>();
  for (const prompt of prompts) {
    const value = prompt.secret
      ? await prompter.askSecret(`  ${prompt.label}`)
      : await prompter.ask(`  ${prompt.label}`);
    if (!value) throw new Error(`${prompt.label} is required.`);
    answers.set(prompt.key, value);
  }

  return answers;
}

/**
 * Whether the credential already in the store may stand, or has to be asked for
 * again.
 *
 * Extracted because the two reasons to ask again are easy to state and were
 * impossible to test: `ensureStaticCredential` reaches a terminal, and the
 * property worth holding — that a re-run of `connect` can always correct a
 * credential — is a property of this decision rather than of the prompting.
 *
 * `provisional` is the one that made `connect` unrecoverable. A credential
 * under the provisional connection id exists only because an earlier `connect`
 * stored one and then failed before settling whose account it was, so no server
 * has ever accepted it — and treating it as established meant a mistyped
 * app-specific password could not be corrected by any spelling of the command
 * that stored it.
 */
export function reuseStoredCredential(input: {
  readonly stored: boolean;
  readonly replace: boolean;
  readonly provisional: boolean;
}): boolean {
  return input.stored && !input.replace && !input.provisional;
}

/**
 * Ask for a static credential — an API key, or an app-specific password.
 *
 * This did not exist, which meant the custom-provider path `docs/detailed/creating-a-provider.md`
 * documents did not work: a manifest declaring `auth: {kind: header}` connected
 * with no complaint, never asked for the key, and then reported itself
 * unauthorized forever — with `doctor` advising the very command that had just
 * declined to help.
 *
 * Idempotent where that is load-bearing rather than tidy: iCloud is three
 * providers sharing one app-specific password, so the second and third
 * `connect` must find it already there and say nothing. `reuseStoredCredential`
 * holds the exceptions.
 *
 * Asking is not discarding. The stored value is read but never deleted here,
 * and the write below happens only once every prompt has been answered — so
 * Ctrl-C, or an empty answer, leaves a working credential exactly as it was.
 * A command that threw away a secret the operator typed and then failed before
 * replacing it would be worse than the trap it was fixing.
 */
export async function ensureStaticCredential(input: {
  manifest: ProviderManifest;
  connectionId: string;
  credentials: SecretStore;
  /** The operator asked for this one again — `--replace`, or naming the connection. */
  replace: boolean;
  /** The connection id is still the placeholder, so nothing has accepted this credential. */
  provisional: boolean;
  prompter?: Prompter;
}): Promise<void> {
  const { manifest, connectionId, credentials, replace, provisional } = input;
  const prompter = input.prompter ?? terminalPrompter;
  const auth = manifest.auth;
  if (auth.kind === 'none' || auth.kind === 'oauth' || auth.kind === 'strategy') return;

  const ref = credentialRefForConnection(manifest, connectionId)!;
  const stored = await credentials.has(ref);

  if (reuseStoredCredential({ stored, replace, provisional })) {
    progress(ok(`credential already stored (${ref})`));
    return;
  }

  // Asked for where "already stored" was expected, so say which of the two
  // reasons it is. Only when something is actually there: on a first connect
  // this line would describe a state that does not exist.
  if (stored) {
    progress(
      style.dim(
        provisional && !replace
          ? `An earlier connect left a credential at ${ref} without finishing, so it was never accepted. ` +
              'Asking again — what is stored is replaced only once you have entered a new one.'
          : `Replacing ${ref} — what is stored is overwritten only once you have entered a new one.`,
      ),
    );
  }

  const prompts = (manifest.setup?.prompts ?? []).filter((p) => p.scope === 'connection');
  if (prompts.length === 0) {
    throw new Error(
      `Provider "${manifest.id}" authenticates with a stored credential but declares no per-account setup prompts, ` +
        `so there is nothing to ask you for. Either add prompts with "scope: connection", or place the value at ${ref} yourself.`,
    );
  }

  const answers = await askForSetup(
    manifest,
    prompts,
    `Stored at ${ref}, in the credential store — never in config.`,
    prompter,
  );

  if (auth.kind === 'basic') {
    // RFC 7617's own encoding. Stored as the header carries it, so nothing
    // downstream has to agree about a JSON shape.
    const username = answers.get(prompts.find((p) => p.field === 'username')!.key)!;
    const password = answers.get(prompts.find((p) => p.field === 'password')!.key)!;
    await credentials.set(ref, `${username}:${password}`);
  } else {
    await credentials.set(ref, answers.get(prompts[0]!.key)!);
  }

  progress(ok('credential stored'));
}

/** Prompt once per profile for a vendor-supplied client, and record only refs. */
export async function ensureOAuthApp(input: {
  manifest: ProviderManifest;
  credentials: SecretStore;
  document: ConfigDocument;
  changes: string[];
  firstForProvider: boolean;
  prompter?: Prompter;
}): Promise<void> {
  const { manifest, credentials, document, changes } = input;
  const prompter = input.prompter ?? terminalPrompter;
  if (manifest.auth.kind !== 'oauth' || !manifest.auth.app) return;

  const app = manifest.auth.app;
  const [existingId, existingSecret] = await Promise.all([
    credentials.get(`${app}/client_id`),
    credentials.get(`${app}/client_secret`),
  ]);

  if (existingId && existingSecret) {
    // The client is stored, so there is nothing to ask for — but if this is the
    // profile's first connection *of this provider*, its console setup has not
    // been done. Show it, once. Gated on the provider being new rather than on
    // the client being present, because refresh tokens on an unpublished Google
    // app expire weekly and reprinting this on every re-authorisation would
    // train someone to scroll past it.
    if (input.firstForProvider) {
      printSetup(
        manifest,
        `The ${app} OAuth client is already set up, so nothing is asked for here — but the ` +
          'APIs and scopes above are per product, and this is the first connection of this one.',
      );
    }
    return;
  }

  const setup = manifest.setup;
  if (!setup) throw new Error(`Provider "${manifest.id}" needs a client but declares no setup.`);

  const shared = setup.prompts.filter((p) => p.scope === 'shared');
  const answers = await askForSetup(
    manifest,
    shared,
    'Asked once per profile. Values go to the credential store, never to config.',
    prompter,
  );

  for (const prompt of shared) {
    await credentials.set(prompt.credential_ref!, answers.get(prompt.key)!);
  }

  const idPrompt = shared.find((p) => p.key === 'client_id');
  const secretPrompt = shared.find((p) => p.key === 'client_secret');

  if (idPrompt && secretPrompt && document.getIn(['oauth_apps', app]) === undefined) {
    document.setIn(['oauth_apps', app], {
      client_id_ref: idPrompt.credential_ref,
      client_secret_ref: secretPrompt.credential_ref,
    });
    // No back-pointer from the provider: the manifest already says which app it
    // uses, and a second copy in config could only ever disagree with it.
    changes.push(`oauth_apps.${app} declared`);
  }
}
