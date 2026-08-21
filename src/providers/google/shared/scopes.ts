import type { ScopeMeaning } from '../../scopes.ts';

/**
 * What the Google scopes we ship actually permit, in plain words.
 *
 * Vendor knowledge, so it lives with the vendor. It used to sit in the CLI,
 * which is where it is *displayed* — but a table of Google scope semantics in
 * `src/cli/` is exactly the leak this layout exists to close: `lanes link
 * connect` should be able to explain any provider's grant without the CLI
 * having learned that provider's vocabulary.
 *
 * Confined to display. Nothing routes on it, and a scope missing from this table
 * is printed unannotated rather than mis-described — silence is the safe failure
 * here.
 */
export const GOOGLE_SCOPE_MEANINGS: Record<string, ScopeMeaning> = {
  // Asked for only when authorising against the client Lanes operates, which
  // needs to tell one caller's refresh from another's. Neither reaches any
  // Google service, and describing them matters precisely because they are the
  // two the operator did not ask for.
  openid: { meaning: 'a signed statement of which Google account this is — no access to anything' },
  email: {
    meaning: 'your address, so the hosted client can tell whose connection this is. Not the mailbox',
  },
  'https://mail.google.com/': {
    meaning: 'full mailbox — read, send, and permanently delete any message',
    broad: true,
  },
  'https://www.googleapis.com/auth/gmail.modify': {
    meaning: 'read, send, and modify any message; no permanent delete',
    broad: true,
  },
  'https://www.googleapis.com/auth/gmail.readonly': { meaning: 'read mail and settings' },
  'https://www.googleapis.com/auth/gmail.compose': { meaning: 'create and send drafts' },
  'https://www.googleapis.com/auth/gmail.settings.basic': {
    // Broad for what it *outlives*, not for how much it touches. A filter keeps
    // acting on mail that has not arrived yet, so this is the only grant here
    // that survives the session, the token, and the connection being disabled.
    meaning: 'create and delete filters, and change your send-as identities — a filter is a standing rule that keeps acting after the session ends',
    broad: true,
  },
  'https://www.googleapis.com/auth/gmail.metadata': {
    meaning: 'headers and labels only, no message bodies',
  },
  'https://www.googleapis.com/auth/drive': {
    meaning: 'every file in the account — read, write, and delete',
    broad: true,
  },
  'https://www.googleapis.com/auth/drive.readonly': { meaning: 'read every file in the account' },
  'https://www.googleapis.com/auth/drive.file': {
    meaning: 'only files this app creates or you pick',
  },
  // Broad, and narrower than `auth/drive` — one file type rather than the whole
  // account. Still every document of that type, including ones this app has
  // never seen, which is the line `drive.file` does not cross.
  'https://www.googleapis.com/auth/spreadsheets': {
    meaning: 'every spreadsheet in the account — read, edit, create, and delete',
    broad: true,
  },
  'https://www.googleapis.com/auth/documents': {
    meaning: 'every document in the account — read, edit, create, and delete',
    broad: true,
  },
  // Calendar's `auth/drive`: it does not merely edit what is on a calendar, it
  // creates and deletes calendars and changes who they are shared with. Listed
  // so the table can say what is refused, never requested.
  'https://www.googleapis.com/auth/calendar': {
    meaning: 'every calendar you can access — read, edit, share, and delete',
    broad: true,
  },
  'https://www.googleapis.com/auth/calendar.readonly': {
    meaning: 'read every calendar you can access',
  },
  // Broad on the same reading as `spreadsheets` — every event on every
  // calendar, including ones this app has never seen. Narrower than
  // `auth/calendar`, which also reaches the calendars themselves.
  'https://www.googleapis.com/auth/calendar.events': {
    meaning: 'every event on every calendar — read, create, change, and delete',
    broad: true,
  },
  // Broad because Google publishes nothing narrower that can write. `tasks` and
  // `tasks.readonly` are the entire vocabulary, so adding one task means
  // holding write and delete over every list in the account.
  'https://www.googleapis.com/auth/tasks': {
    meaning: 'every task list — read, create, edit, organise, and delete',
    broad: true,
  },
  'https://www.googleapis.com/auth/tasks.readonly': { meaning: 'read your task lists and tasks' },
  // Refused, and listed for the same reason as `auth/calendar`: a contact card
  // deleted through the API is gone.
  'https://www.googleapis.com/auth/contacts': {
    meaning: 'read, edit, and permanently delete your contacts',
    broad: true,
  },
  'https://www.googleapis.com/auth/contacts.readonly': { meaning: 'read your saved contacts' },
  'https://www.googleapis.com/auth/contacts.other.readonly': {
    meaning: 'read the addresses Gmail saved automatically in "Other contacts"',
  },
};
