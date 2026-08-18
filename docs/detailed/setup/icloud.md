# Connecting iCloud

Mail, Calendar, and Contacts, from one Apple Account.

```
lanes link connect icloud
```

That connects all three. You are asked for your Apple Account address and one
app-specific password, once — Apple issues app-specific passwords at *account*
scope, so a single one covers every service.

## The app-specific password

Your normal Apple Account password will not work. Apple refuses it for
third-party clients, and there is no way around that.

1. Sign in at **[account.apple.com](https://account.apple.com)** and open
   **Sign-In and Security**.
2. **Two-factor authentication must be on.** Without it Apple does not offer
   app-specific passwords at all, and the section below will simply not appear.
3. **App-Specific Passwords → Generate**. Name it `Lanes Link` — the name is the
   only way to revoke this one later without cutting off your other devices.
4. Copy the sixteen characters. Apple shows them once, formatted
   `xxxx-xxxx-xxxx-xxxx`; the hyphens are cosmetic and either form is accepted.

You can hold **25** at a time, and revoke them individually.

> **Changing your Apple Account password revokes every app-specific password at
> once.** This is the cause of most sudden iCloud failures — everything works for
> weeks and then all three services stop together. The fix is to generate a new
> password and run `lanes link connect icloud --replace`, which re-prompts and
> updates all three. Without `--replace`, connect finds the revoked password
> already stored and reuses it.

The password goes into the encrypted credential store, never into config. It is
stored once at `icloud/<account>` and shared by the three providers.

## What you get

| | |
|---|---|
| **iCloud Mail** | `list_mailboxes`, `search_messages`, `get_message` · write: `mark_messages`, `move_messages`, `send_message` |
| **iCloud Calendar** | `list_calendars`, `list_events`, `get_event` · write: `create_event`, `update_event`, `delete_event` |
| **iCloud Contacts** | `list_addressbooks`, `search_contacts` · write: `create_contact` |
| **iCloud Drive** | `list_files`, `search_files`, `read_file`, `file_info` · write: `write_file`, `move_file`, `create_folder`, `trash_file` |

### Editing an event does not disturb the rest of it

`update_event` patches the event that is there rather than rebuilding it, so
attendees and their replies, alarms, repetition rules, and anything another
client wrote all survive a change of time or title. It also bumps the event's
sequence number, which is how your other devices learn something changed.

Both `update_event` and `delete_event` are conditional on the version they read.
If the event changed in between — you edited it on your phone — the write is
refused and says so, rather than overwriting quietly.

**`connect` grants the whole provider, writes included** — one `icloud_mail.*`
rule rather than a line per capability. So sending mail and creating events work
immediately, and narrowing is something you do rather than something you undo.
`lanes link policy list` shows what is reachable, and because these are three
separate providers you can cut one without touching the others:

```
lanes link policy deny icloud_mail.send_message   # read mail, never send it
lanes link policy deny icloud_mail.*              # calendars and contacts still work
```

### Reading never marks mail as read

Every read path opens the mailbox with `EXAMINE` and fetches with `BODY.PEEK`, so
an agent reading your inbox does not change what you see in Mail. Marking
something read is a separate, write-bundle capability.

### Nothing here can delete mail

There is no `EXPUNGE`, and `\Deleted` is not a flag an agent can set. Moving a
message to Trash is available (`move_messages`) and is reversible; permanent
deletion is not offered at all.

## What is not available

- **Reminders and Notes.** Apple moved to-do lists to a private store after iOS
  13, so CalDAV returns legacy data or empty tombstones for them, and Notes were
  never exposed over any open protocol. Neither is reachable by any third-party
  client, not just this one.
- **A display name has to be configured.** SMTP sends exactly what is composed, so
  without `config.from_name` on the connection the `From` header is a bare
  address. See the `From` header notes in [`../providers.md`](../providers.md).
- **Attachment contents, when reading.** `get_message` reports each attachment's
  name, type, and size, but not its bytes. Sending attachments does work — see
  ADR-017 — and forwarding one that arrived by mail is done by naming it
  (`{ "message_id": "<...>" }`), which never materialises the bytes for you to
  pass along.

## iCloud Drive works differently from the other three

```
lanes link connect icloud_drive
```

No password, no browser, nothing to type. Apple publishes no protocol for Drive
at all — but on a Mac it is a folder the system keeps in sync, so this reads it
directly.

That has one consequence worth understanding: **it only works on the Mac holding
the files.** There is no credential involved, so there is nothing that could be
copied to a server elsewhere; the permission is macOS's, held against the process
on that machine. A cloud deployment will reach Drive by relaying to a local
instance rather than by holding a token — [ADR-011](../adr/011-local-filesystem.md)
covers the shape and why it is not built yet.

Two things to know:

- **Nothing deletes permanently.** `trash_file` moves to the Finder's Trash.
- **Everything stays inside the folder.** Paths are resolved through symlinks
  before being checked, so a link pointing out of iCloud Drive is refused rather
  than followed. `.git`, `.ssh`, and `node_modules` are never reachable.
- If "Optimise Mac Storage" has evicted a file, reading it says so and tells you
  how to fetch it, rather than returning the placeholder's contents as if they
  were the file.

You may need to grant your terminal **Files and Folders** (or Full Disk) access
in System Settings → Privacy & Security the first time.

## Limits worth knowing

- Event queries are capped at **one year** per request; iCloud rejects wider
  windows.
- There is no push. Nothing here subscribes; an agent asks when it wants to know.
- iCloud throttles *reconnection* harder than open sessions, so the mail
  connector holds one connection per account and reuses it.

## Is there an OAuth option?

Apple shipped one in October 2025 — the article is titled *"Access your iCloud
Mail, Calendar, and Contacts in third-party apps"* — and Outlook uses it. It is
partner-gated: the developer service behind it publishes no scopes for these
services, so it is not available to write against.

If that changes, it is a small change here. Auth is orthogonal to connectivity in
this codebase: the three manifests would swap `auth: basic` for `auth: oauth` and
nothing about the connectors would move.

## Troubleshooting

**"The server rejected the credential"** — an Apple Account password used where
an app-specific one belongs, or a password revoked by an account password change.
Generate a new one and run `lanes link connect icloud --replace`. The `--replace`
matters: the credential that was refused is the one in the store, and a bare
re-run reuses it rather than asking. Nothing is discarded until you have entered
the new password in full, so cancelling at the prompt leaves the old one alone.

A connect that never got as far as naming the account files its credential under
`icloud/pending`. That one is re-prompted for automatically — it has never been
accepted by anything — so a mistyped password on a first connect needs no flag.

**Two accounts** — connect each in turn. `lanes link connect icloud_mail` a second
time will ask which account when it cannot tell, or pass `--id` to name one.

**The username** — Apple documents the IMAP username as sometimes the local part
alone. Give the full address; it works for both IMAP and SMTP, and SMTP requires
it.
