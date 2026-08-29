import type { ScopeMeaning } from '../../scopes.ts';

/**
 * What the Microsoft Graph scopes we ship actually permit, in plain words.
 *
 * Vendor knowledge, so it lives with the vendor — the same reasoning as
 * `../../google/shared/scopes.ts`, and the same confinement: nothing routes on
 * this, and a scope missing from the table is printed unannotated rather than
 * mis-described.
 */
export const MICROSOFT_SCOPE_MEANINGS: Record<string, ScopeMeaning> = {
  offline_access: {
    meaning:
      'keep the connection working without sending you to a browser again — Microsoft issues no refresh token without it',
  },
  'User.Read': {
    meaning: 'your name and address, so this connection can be labelled with whose it is. No mail, calendar, or files',
  },
  // Graph's mail scopes are coarser than Gmail's. There is no equivalent of
  // `gmail.metadata` or a per-message grant, so reading one message means the
  // grant reaches every message — which is exactly why `gmail.modify` is on this
  // list too.
  'Mail.ReadWrite': {
    meaning: 'read, file, and modify any message in the mailbox; no permanent delete',
    broad: true,
  },
  'Mail.Read': { meaning: 'read any message in the mailbox' },
  // Broad for where it lands rather than what it reaches. A sent message leaves
  // the account, arrives as the person, and cannot be recalled — the same
  // argument that puts Reddit's three on the broad list.
  'Mail.Send': {
    meaning: 'send mail as you — it leaves the account under your name and cannot be recalled',
    broad: true,
  },
  'Calendars.ReadWrite': {
    meaning: 'read and write every event in every calendar on the account, including invitations sent to others',
    broad: true,
  },
  'Calendars.Read': { meaning: 'read every event in every calendar on the account' },
  'Contacts.Read': { meaning: 'read the address book. Read-only — nothing here writes a contact' },
  // Broad, and the only one here that is broad for want of a narrower option.
  // Google Drive is reached with `drive.file`, which covers files this app made
  // or the person picked and nothing else; Graph publishes no equivalent, so the
  // smallest grant that can create a folder is one that reaches every file in
  // the drive.
  'Files.ReadWrite': {
    meaning: 'read and write every file in your OneDrive — Microsoft publishes no per-file equivalent of Google\'s drive.file',
    broad: true,
  },
  'Files.Read': { meaning: 'read every file in your OneDrive' },
  'Tasks.ReadWrite': {
    meaning: 'read and write every list and task in Microsoft To Do',
    broad: true,
  },
  'Tasks.Read': { meaning: 'read every list and task in Microsoft To Do' },
};
