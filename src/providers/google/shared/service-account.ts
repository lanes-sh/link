import { GOOGLE_APP } from './oauth.ts';

/**
 * The other way into a Google account: a key, instead of a browser.
 *
 * Google issues service accounts, and a service account holds a private key
 * that does not expire. It is the answer to the one complaint the browser flow
 * cannot fix — that a client left in "Testing" has its refresh tokens expired
 * after seven days, so every connection has to be re-approved weekly until
 * verification lands. A key is not subject to that, or to any other policy the
 * issuer applies to consent, because nobody consented.
 *
 * What it costs is reach, and the cost is different per product, which is why
 * `delegation` is a parameter rather than a constant. A service account is an
 * identity in its own right: it has a Drive, and a calendar, and no mailbox and
 * no contacts. So Drive, Sheets, Docs and Calendar work by *sharing* something
 * with its address, and Gmail, Contacts and Tasks work only if a Workspace
 * administrator lets the key act as a person. A personal Google account has no
 * administrator, so for those three there is no key route at all and the
 * walkthrough says so rather than letting someone find out later.
 */

/** Where the key lives. One file per profile, covering every Google provider. */
export const GOOGLE_KEY_REF = `${GOOGLE_APP}/service_account_key`;

const SHARE_HINT: Record<string, string> = {
  Drive: 'a folder (Share → paste the address → Editor)',
  Sheets: 'a spreadsheet (Share → paste the address → Editor)',
  Docs: 'a document (Share → paste the address → Editor)',
  Calendar:
    'a calendar (Settings for that calendar → "Share with specific people" → paste the address)',
};

export const googleServiceAccount = (
  product: string,
  scopes: readonly string[],
  delegation: 'optional' | 'required',
  apis: readonly string[],
) => ({
  method: 'service_account',
  label: 'Service account key',
  delegation,
  key_ref: GOOGLE_KEY_REF,
  reach:
    delegation === 'optional'
      ? `a JSON key that never expires, and no browser. Reaches only what you share with the ` +
        `key's own address, so nothing in the account moves until you share it.`
      : `a JSON key that never expires, and no browser. ${product} has nothing that belongs to ` +
        `a key, so this needs a Google Workspace administrator to let it act as you — a personal ` +
        `Google account cannot do it.`,
  subject_label:
    delegation === 'optional'
      ? 'Google account to act as, if an administrator has granted it'
      : 'Google account to act as',
  setup: {
    summary:
      delegation === 'optional'
        ? `${product} can authenticate with a service account key instead of signing in. The key ` +
          `does not expire, so this is connected once and stays connected. It reaches only what ` +
          `is shared with it, which is the trade: you pick what it can see, one resource at a time.`
        : `${product} can authenticate with a service account key instead of signing in. The key ` +
          `does not expire — but a key has no mailbox, contacts or task lists of its own, so this ` +
          `route works only where a Google Workspace administrator has authorised the key to act ` +
          `as a user in their domain. On a personal Google account, use the browser instead.`,
    docs: 'docs/detailed/setup/google.md',
    docs_url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    steps: [
      'Create or pick a project at https://console.cloud.google.com',
      `Enable the APIs:\n       gcloud services enable ${apis.join(' ')} --project=YOUR_PROJECT\n       Without gcloud: APIs & Services → Library, and search for each by name.`,
      'IAM & Admin → Service Accounts → Create service account. Name it "Lanes Link". Grant it no project roles — the roles page governs Google Cloud resources, and nothing here is one.',
      'Open the account → Keys → Add key → Create new key → JSON. It downloads once. You are asked for the path to that file next; its contents go to the credential store and the file itself is not read again.',
      ...(delegation === 'required'
        ? [
            'THIS PRODUCT NEEDS DOMAIN-WIDE DELEGATION, which only a Google Workspace administrator can grant. Copy the service account\'s numeric "Unique ID" (the client ID, not the email) from its Details tab.',
            `In the Workspace Admin console → Security → Access and data control → API controls → Domain-wide delegation → Add new. Paste that client ID, and paste this scope list exactly:\n       ${scopes.join(',\n       ')}\n       All of them, comma-separated, in one field. A partial list is refused the same way a missing one is, and the refusal does not say which scope was short.`,
            'Delegation can take a few minutes to take effect. If the first connect is refused with "unauthorized_client", wait and run it again — nothing was stored.',
          ]
        : [
            `Share what you want reachable with the service account's email address — it ends in .iam.gserviceaccount.com and is printed once the key is stored. For ${product} that means ${SHARE_HINT[product] ?? 'the resource itself'}.`,
            'Nothing else in the account is reachable, including files the same person owns. That is the point of this route, and it is also the thing to remember when something is "missing" — it has not been shared yet.',
            'A Workspace administrator can instead grant domain-wide delegation, which lets the key act as a user and reach everything they can. The connect prompt asks which account to act as; leaving it blank means the key acts as itself.',
          ]),
    ],
    prompts: [
      {
        key: 'service_account_key',
        label: 'Path to the downloaded JSON key (or paste its contents)',
        // Read from a path in the ordinary case, so this is not a secret typed
        // into a terminal — but it may be pasted, and a pasted private key must
        // not land in scrollback.
        secret: true,
        scope: 'shared' as const,
        credential_ref: GOOGLE_KEY_REF,
      },
    ],
  },
});
