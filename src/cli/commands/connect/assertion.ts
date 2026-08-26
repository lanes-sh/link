import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { ASSERTION_GRANT, parseAssertionKey } from '#connectivity/auth/index.ts';
import { credentialRefForConnection, type AuthAssertion, type ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import { ok, progress, style } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { askForSetup, printSetup } from './setup.ts';

/**
 * The counterpart to `authorise.ts`, for a provider authenticated by a key.
 *
 * The same conversation, minus the browser: show the console work, take what it
 * produced, put it in the store. What differs is that there are two halves and
 * they have different lifetimes — the key is one file covering every provider
 * of a vendor, and the account it acts as is per connection. So the key is
 * asked for once per profile and the subject once per account, and re-running
 * `connect` for a second provider asks for neither.
 */

/**
 * Take a path, or the file's contents.
 *
 * A key arrives as a downloaded file, and a downloaded file is a path — asking
 * someone to open it and paste several hundred characters of PEM into a
 * terminal is asking for a truncated key and an error two steps later. Pasting
 * still works for anyone who would rather, which is why this looks at the shape
 * of the answer rather than at a flag.
 *
 * What is *stored* is always the contents. A path is a fact about one machine
 * and this credential outlives it: the same profile is read by a deployed
 * revision that has no such file, and a store holding a path would fail there
 * with an error about the filesystem rather than about the credential.
 */
async function contentsOf(answer: string): Promise<string> {
  if (answer.startsWith('{')) return answer;

  const expanded = answer.startsWith('~/') ? resolve(homedir(), answer.slice(2)) : answer;
  const path = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);

  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `No file at ${path}. Give the path to the key the console downloaded, or paste its contents.`,
    );
  }
}

/**
 * Ensure the profile holds the key, and this connection holds a pointer to it.
 *
 * Idempotent on the key for the same reason `ensureStaticCredential` is: seven
 * providers share one file, and the second `connect` must find it already there
 * and say so rather than asking again. The subject is not idempotent in the
 * same way — it is per connection, and every connection is a first one.
 */
export async function authoriseWithKey(input: {
  readonly manifest: ProviderManifest;
  readonly assertion: AuthAssertion;
  readonly connectionId: string;
  readonly credentials: SecretStore;
  readonly changes: string[];
  /** The operator asked to be asked again — a rotated key, or the wrong account. */
  readonly replace: boolean;
  readonly prompter?: Prompter;
}): Promise<void> {
  const { manifest, assertion, connectionId, credentials, changes, replace } = input;
  const prompter = input.prompter ?? terminalPrompter;

  const keyPrompt = assertion.setup.prompts.find((prompt) => prompt.scope === 'shared');
  if (!keyPrompt) {
    throw new Error(
      `Provider "${manifest.id}" declares auth.assertion with no shared prompt, so there is no key to ask for.`,
    );
  }

  const stored = await credentials.has(assertion.key_ref);

  // `stored && !replace`, and deliberately not `reuseStoredCredential` — which
  // also asks whether the connection id is still provisional. That question is
  // right for a per-connection credential, where a provisional id means an
  // earlier connect stored something no server ever accepted. It is wrong here:
  // this key is shared across the whole profile, so a *first* connect of a
  // second provider is provisional by definition while the key it finds was
  // stored deliberately and may already be in use. Asking again there made a
  // stored key unusable — the preflight said it had everything it needed, and
  // the run that followed immediately asked for it.
  if (stored && !replace) {
    // The walkthrough still prints. The key is shared and already held, but the
    // *sharing* is per resource and per product: whoever connects Sheets after
    // Drive has a key that works and a spreadsheet nobody has shared with it
    // yet, and that failure looks exactly like a broken credential.
    printSetup(
      manifest,
      `The key is already stored at ${assertion.key_ref}, so it is not asked for again — but what ` +
        'it can reach is granted per resource, and this is the first connection of this one.',
      assertion.setup,
    );
    progress(ok(`key already stored (${assertion.key_ref})`));
    // Named because this is the only way past a key that is stored and wrong,
    // and a well-formed key for the wrong project is refused by the token
    // endpoint rather than here.
    progress(style.dim(`  To replace it: lanes link connect ${manifest.id} --replace`));
  } else {
    if (stored) {
      progress(
        style.dim(
          `Replacing ${assertion.key_ref} — what is stored is overwritten only once you have entered a new one.`,
        ),
      );
    }

    const answers = await askForSetup(
      manifest,
      [keyPrompt],
      `Stored at ${assertion.key_ref}, in the credential store — never in config.`,
      prompter,
      assertion.setup,
    );

    const contents = await contentsOf(answers.get(keyPrompt.key)!);

    // Parsed before it is written, so the wrong file is caught here rather than
    // at the token endpoint. The two candidates live on adjacent pages of the
    // same console and `parseAssertionKey` knows how to tell them apart.
    const key = parseAssertionKey(contents, assertion.key_ref);

    await credentials.set(assertion.key_ref, contents);
    changes.push(`${assertion.key_ref} stored`);
    progress(ok(`key stored — it acts as ${key.client_email}`));
  }

  const subject = await askForSubject(assertion, prompter);

  await credentials.set(
    credentialRefForConnection(manifest, connectionId)!,
    JSON.stringify({
      grant: ASSERTION_GRANT,
      key_ref: assertion.key_ref,
      ...(subject ? { subject } : {}),
    }),
  );

  progress(ok(subject ? `authenticated as ${subject}` : 'authenticated'));
}

/**
 * Who the key acts as, where it acts as anyone.
 *
 * Blank is a real answer when delegation is `optional` — the key is then an
 * identity in its own right. It is refused when delegation is `required`,
 * because the alternative is a credential that authenticates perfectly and
 * finds nothing: there is no mailbox or contact list belonging to a key, so
 * every call would return an empty result rather than an error, which is the
 * worst way for this to be wrong.
 */
async function askForSubject(
  assertion: AuthAssertion,
  prompter: Prompter,
): Promise<string | undefined> {
  const optional = assertion.delegation === 'optional';

  if (!prompter.interactive) {
    if (optional) return undefined;
    throw new Error(
      `This provider can only reach an account by acting as someone, and this run is ` +
        `non-interactive so there is nobody to ask who. Re-run in a terminal.`,
    );
  }

  progress();
  const answer = await prompter.ask(
    `  ${assertion.subject_label}${optional ? style.dim(' [none]') : ''}`,
  );

  if (answer.length > 0) return answer;

  if (optional) return undefined;

  throw new Error(
    `${assertion.subject_label} is required here: this provider has nothing that belongs to a ` +
      'key, so a connection that acts as nobody would authenticate and then find every ' +
      'mailbox, list and calendar empty.',
  );
}
