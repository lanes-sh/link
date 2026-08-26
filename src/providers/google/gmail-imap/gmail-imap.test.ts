import { describe, expect, test } from 'bun:test';
import { credentialRefForConnection } from '#connectivity';
import { manifestOf, PROVIDER_MANIFESTS } from '#providers/index.ts';
import { gmail } from '../gmail/index.ts';
import { gmailImap } from './index.ts';

// `gmail` is one of the two providers that carry a capability of their own, so
// it arrives as a definition rather than a bare manifest. Everything asked of
// it here is a manifest question.
const gmailManifest = manifestOf(gmail);

/**
 * The mail route for an account that cannot take either other one.
 *
 * Constructing the manifest at all is most of the check — `defineProvider`
 * refuses an imap connector that is not `basic`, and refuses `basic` without
 * exactly one username prompt and one password prompt. What is left is what a
 * schema cannot see: that this credential is its own, that nothing of the
 * message reaches the audit log, and that the dead end it exists to answer
 * actually points at it.
 */

describe('the credential', () => {
  test('is its own, and shares nothing with the OAuth providers', () => {
    // No `auth.app`, so the ref derives from the provider id. An `app` of
    // `google` would have filed an app password in the same namespace as the
    // shared OAuth client and the service account key — three unrelated
    // secrets, one of which is rotated by a completely different console.
    expect(credentialRefForConnection(gmailImap, 'main')).toBe('gmail_imap/main');
    expect(credentialRefForConnection(gmailManifest, 'main')).toBe('gmail/main');
  });

  test('is asked for as a username and a password, which is what basic stores', () => {
    const fields = (gmailImap.setup?.prompts ?? []).map((prompt) => prompt.field);

    expect(fields).toEqual(['username', 'password']);
    expect(gmailImap.auth.kind).toBe('basic');
  });
});

describe('the audit log', () => {
  test('gets identifiers and never the message', () => {
    const redact = gmailImap.redact ?? {};

    // Empty rather than absent: absent means "withhold everything" by default
    // and would read the same here, but `send_message` carries `attachments`,
    // which may literally be a file. Saying it explicitly is what keeps a later
    // edit from opting one of these back in without noticing what is in it.
    expect(redact.send_message).toEqual([]);
    // A query is content. "Who did I email about the diagnosis" is the whole
    // message, so the search terms are never kept.
    expect(redact.search_messages).not.toContain('query');
    expect(redact.search_messages).toContain('mailbox');
  });
});

describe('the dead end it answers', () => {
  test('is named by Gmail, and names a provider that exists', () => {
    // The service-account route is refused on a personal account, and the text
    // that says so points here. A rename on either side breaks the sentence
    // silently — it is prose, and prose compiles.
    const assertion = gmailManifest.auth.kind === 'oauth' ? gmailManifest.auth.assertion : undefined;

    expect(assertion?.reach).toContain(gmailImap.id);
    expect(PROVIDER_MANIFESTS.map((manifest) => manifest.id)).toContain(gmailImap.id);
  });
});
