import { defineProvider } from '#connectivity';

/**
 * Gmail over IMAP, for the account that cannot use either other route.
 *
 * A personal Google account has exactly one way to a mailbox that does not
 * expire, and this is it. The two alternatives both fail for a reason that is
 * not about effort:
 *
 * - The REST provider (`gmail`) authorises in a browser, and an OAuth client
 *   left in "Testing" has every refresh token it issues expired after seven
 *   days. Publishing the client fixes that and is the better answer where it is
 *   available — see ADR-038 and `docs/detailed/setup/google.md`.
 * - The key route (`auth.assertion` on `gmail`) does not apply at all. A service
 *   account has no mailbox of its own, so it can only reach one by acting as
 *   somebody, and that grant is domain-wide delegation — made in a Workspace
 *   admin console that a personal account does not have.
 *
 * An app password has neither problem. It is issued by the account holder to
 * themselves, it does not expire, and IMAP asks no authorization server for
 * anything. What it costs is reach and shape: this is a mailbox over IMAP and
 * SMTP, so it is the mail capability set rather than Gmail's API — no labels
 * vocabulary, no threads resource, no drafts. Searching, reading, flagging,
 * moving and sending, which is most of what a mailbox is for.
 *
 * The mirror image of `../shared/service-account.ts`, and deliberately so: that
 * one covers Workspace and not personal accounts, this one covers personal
 * accounts and not Workspace. Google turned off basic authentication for
 * Workspace in March 2025, and an administrator can disable app passwords
 * outright, so an account under a domain should take one of the other two.
 *
 * A separate manifest rather than a route on `gmail` because a manifest has one
 * connector, and IMAP is a different protocol from HTTPS — the same reason
 * iCloud is three providers rather than one. It also makes the policy line
 * separable: `gmail_imap.*` can be allowed without granting the REST surface,
 * or the other way round.
 */
export const gmailImap = defineProvider({
  id: 'gmail_imap',
  name: 'Gmail (IMAP)',
  description:
    'Read, search, and send mail in a personal Gmail mailbox over IMAP and SMTP, with an app password that does not expire.',
  connector: {
    kind: 'imap',
    host: 'imap.gmail.com',
    port: 993,
    smtp: {
      host: 'smtp.gmail.com',
      port: 587,
      starttls: true,
      // Gmail's limit is 25 MB for the whole encoded message rather than the
      // 20 MB default, and the send path derives the usable weight of the files
      // from it. Declaring the real number is what makes an oversized message
      // refused before dialling rather than part-way through DATA.
      max_message_bytes: 25 * 1024 * 1024,
    },
  },
  // Not a choice. `defineProvider` refuses anything else on an imap connector,
  // because every mail host that matters issues an app password and expects it
  // over Basic — and Gmail's OAuth path belongs to the REST provider.
  auth: { kind: 'basic' },
  // No `app`: this is one provider rather than a family, so the credential
  // lands at `gmail_imap/<connection>` and is shared with nothing. An app
  // password is issued per app rather than per account, so there would be
  // nothing to share it with even if there were siblings.
  identity: { kind: 'connector' },
  setup: {
    summary:
      'Gmail over IMAP uses an app password — a sixteen-character password you issue to yourself, ' +
      'which is not your Google account password and does not expire. Nothing is authorised in a ' +
      'browser and nothing has to be re-approved later. This is the personal-account route: ' +
      'Google turned off basic authentication for Workspace accounts in March 2025, and a Workspace ' +
      'administrator can disable app passwords for the whole domain.',
    docs: 'docs/detailed/setup/google.md',
    docs_url: 'https://support.google.com/accounts/answer/185833',
    steps: [
      'Two-Step Verification has to be on. Without it Google does not offer app passwords at all, and the page below returns "the setting you are looking for is not available for your account" rather than saying why. Turn it on at https://myaccount.google.com/signinoptions/twosv.',
      'Open https://myaccount.google.com/apppasswords and create one. Name it "Lanes Link" — the name is the only way to revoke this one later without cutting off your other devices.',
      'Copy the sixteen characters. Google shows them once, in four groups of four; the spaces are cosmetic and it is accepted either way.',
      'You are asked for your full address next, which is the one you sign in with, ending @gmail.com.',
      'IMAP is on by default. If a login is refused with a mailbox error rather than an authentication error, check Gmail → Settings → See all settings → Forwarding and POP/IMAP → IMAP access.',
    ],
    // What a transport cannot say for itself, because it must not know which
    // vendor it is talking to. The first sentence is the mistake this route
    // actually produces: an app password looks enough like a password that the
    // account password gets pasted instead, and IMAP reports both identically.
    troubleshooting:
      'For Gmail this is almost always a Google account password used where an app password belongs, ' +
      'or an account without Two-Step Verification — app passwords do not exist without it. Generate ' +
      'one at https://myaccount.google.com/apppasswords and re-run: lanes link connect gmail_imap --replace.',
    prompts: [
      {
        key: 'username',
        label: 'Google account (the full email address)',
        secret: false,
        scope: 'connection' as const,
        field: 'username' as const,
      },
      {
        key: 'password',
        label: 'App password (sixteen characters)',
        secret: true,
        scope: 'connection' as const,
        field: 'password' as const,
      },
    ],
  },
  // The mail capability set, so the same reasoning as `icloud_mail` applies
  // verbatim: opted back in one key at a time, everything unlisted withheld.
  redact: {
    // Never the search terms — a query is content, and "who did I email about
    // the diagnosis" is the whole message.
    search_messages: ['mailbox', 'limit', 'unseen', 'flagged'],
    // Identifiers only, and all of them: which mailbox, which message, which
    // attachment. What the file turned out to be — name, size, type, digest —
    // is recorded by the handler through `audit.annotate`, the same way the send
    // path records what it attached.
    get_attachment: ['mailbox', 'uid', 'message_id', 'attachment_id'],
    get_message: ['mailbox', 'uid', 'include_body'],
    mark_messages: ['mailbox', 'add_flags', 'remove_flags'],
    // `destination_flag` alongside `destination`: two spellings of the same
    // fact, and keeping only one means a junk move logs with no destination.
    move_messages: ['mailbox', 'destination', 'destination_flag'],
    // Nothing. The recipients and the body are the message, and `attachments`
    // may literally contain a file. What was attached is recorded by the send
    // path itself through `audit.annotate` — filename, size, type, SHA-256 and
    // origin. Identifiers, not content.
    send_message: [],
  },
});
