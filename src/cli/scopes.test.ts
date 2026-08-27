import { describe, expect, test } from 'bun:test';
import { PROVIDER_MANIFESTS as PROVIDERS } from '#providers/index.ts';
import { describeScope, describeScopes, shortScope } from './scopes.ts';

/**
 * The scope disclosure is a security surface, not cosmetics: it is the only
 * point at which someone sees, in words they did not have to decode, that
 * connecting Gmail grants permanent delete. A scope that stops being marked
 * broad, or a manifest that grows one nobody described, would remove that
 * warning silently — so both are asserted here.
 */

describe('describeScope', () => {
  test('full-mailbox and full-drive access are marked broad', () => {
    for (const scope of [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/drive',
    ]) {
      expect(describeScope(scope).broad).toBe(true);
    }
  });

  test('restricted scopes are not', () => {
    for (const scope of [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/drive.file',
      'read',
    ]) {
      expect(describeScope(scope).broad).toBe(false);
    }
  });

  test('an unknown scope is described as unannotated rather than guessed at', () => {
    const described = describeScope('https://api.example.com/auth/something');
    expect(described.meaning).toBeUndefined();
    expect(described.broad).toBe(false);
  });
});

describe('shortScope', () => {
  test('renders the part a human reads', () => {
    expect(shortScope('https://www.googleapis.com/auth/gmail.readonly')).toBe('gmail.readonly');
    expect(shortScope('https://mail.google.com/')).toBe('mail.google.com');
    expect(shortScope('read')).toBe('read');
  });
});

describe('every scope we ship is described', () => {
  // A manifest gaining a scope with no entry in the table would print a bare
  // URL and, worse, would not be flagged even if it granted everything.
  test.each(PROVIDERS.filter((manifest) => manifest.auth.kind === 'oauth'))(
    '$id',
    (manifest) => {
      const scopes = manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [];
      const undescribed = describeScopes(scopes).filter((entry) => !entry.meaning);
      expect(undescribed.map((entry) => entry.scope)).toEqual([]);
    },
  );
});

describe('the Google manifests stay at the documented minimum', () => {
  // Each server advertises more than this — `mail.google.com` and `auth/drive`
  // among them. Requesting the full advertised set was tested against the live
  // service and changed nothing: the gate is Workspace Developer Preview
  // enrolment, not scope. So these stay at what Google's own docs ask for, and
  // this test is here to stop them creeping back up on a hunch.
  //
  // There are five exceptions now. The first three are the same exception three
  // times. Organising mail is label editing in Gmail's model — read-state,
  // spam, and archive are all label edits — and `gmail.modify` is the only
  // scope that permits it. Editing a spreadsheet or document someone already
  // has is the same shape: `drive.file` reaches only files this app created,
  // its other half needs a Picker that an MCP endpoint does not have, and
  // `spreadsheets`/`documents` are the only scopes that cross that line.
  //
  // The fourth and fifth are new arguments rather than the old one repeated.
  // `calendar.events` is the `spreadsheets` shape — every event on every
  // calendar, including ones this app has never seen — with the wrinkle that
  // Calendar's `drive.file` equivalents do exist upstream
  // (`calendar.events.owned`, `calendar.app.created`) and are absent from the
  // vendored spec's `security` blocks, so requesting one would be a grant no
  // operation accepts. `tasks` is not the widest of several: it is the only
  // scope Google publishes for Tasks that can write at all, so the choice was
  // between it and a read-only provider.
  //
  // Each is pinned to its exact scope below rather than the rule being relaxed,
  // so a sixth still has to be argued for. Note what none of them grant:
  // `mail.google.com`, `auth/drive`, and `auth/calendar` — the three that would
  // make an account wholly reachable — are still refused, and so is `contacts`,
  // whose read-only halves are all the Contacts provider asks for.
  const scopesOf = (id: string) => {
    const manifest = PROVIDERS.find((entry) => entry.id === id);
    return manifest?.auth.kind === 'oauth' ? [...manifest.auth.scopes].sort() : [];
  };

  test('gmail asks for modify, but never full-mailbox', () => {
    expect(scopesOf('gmail')).toEqual(
      [
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.readonly',
        // Blocking a sender. `filters.create` and `filters.delete` accept this
        // and nothing else; reporting spam needs only `modify` and predates it.
        'https://www.googleapis.com/auth/gmail.settings.basic',
      ].sort(),
    );
  });

  // The MCP provider does *not* follow `gmail` up. Its tools are Google's, not
  // ours, and its calls fail on preview enrolment rather than scope, so `modify`
  // would buy nothing there and cost real privilege.
  test('gmail_mcp stays at read and compose', () => {
    expect(scopesOf('gmail_mcp')).toEqual(
      [
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.readonly',
      ].sort(),
    );
  });

  test('drive asks for neither full-drive nor modify', () => {
    expect(scopesOf('drive')).toEqual(
      [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
      ].sort(),
    );
  });

  // Sheets and Docs each keep `drive.readonly` beside the broad one. It is not
  // redundant: `spreadsheets` cannot answer `drive/v3/about`, which is how the
  // connection gets labelled with an address.
  test('sheets asks for spreadsheets, but never full-drive', () => {
    expect(scopesOf('sheets')).toEqual(
      [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ].sort(),
    );
  });

  test('docs asks for documents, but never full-drive', () => {
    expect(scopesOf('docs')).toEqual(
      [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
      ].sort(),
    );
  });

  // Calendar keeps `calendar.readonly` beside the broad one for the same kind
  // of reason Sheets keeps `drive.readonly`: two operations accept nothing
  // narrower. Here they are `calendarList.list` and `freeBusy` — the list of
  // calendars, and the "when am I free" primitive.
  test('calendar asks for events, but never the calendars themselves', () => {
    expect(scopesOf('calendar')).toEqual(
      [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
      ].sort(),
    );
  });

  // One scope, and no narrower one exists — see the note above.
  test('tasks asks for the only scope that writes', () => {
    expect(scopesOf('tasks')).toEqual(['https://www.googleapis.com/auth/tasks']);
  });

  // The only Google provider here that asks for nothing broad at all. Two
  // scopes because Google keeps contacts in two stores, and both are read-only:
  // the write scope, `contacts`, permanently deletes.
  test('contacts stays read-only, across both stores', () => {
    expect(scopesOf('contacts')).toEqual(
      [
        'https://www.googleapis.com/auth/contacts.other.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
      ].sort(),
    );
  });

  test('the broad scopes are exactly the sixteen that were argued for', () => {
    const broad = PROVIDERS.flatMap((manifest) => {
      const scopes = manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [];
      return describeScopes(scopes)
        .filter((entry) => entry.broad)
        .map((entry) => `${manifest.id} ${entry.scope}`);
    });

    expect(broad.sort()).toEqual(
      [
        'gmail https://www.googleapis.com/auth/gmail.modify',
        // The sixth, and the only one on this list that is broad for its
        // *duration* rather than its reach. Everything else here grants a wider
        // set of actions on things that already exist; `settings.basic` grants
        // one action on things that do not exist yet. A filter created under it
        // keeps sorting, labelling, or trashing mail after the session ends,
        // after the token expires, and after the connection is disabled —
        // `lanes link policy deny` takes away the tool and cannot take away the
        // rule. That is the `messages.delete` argument at one remove, and it is
        // why blocking a sender costs a re-consent while reporting spam does
        // not.
        'gmail https://www.googleapis.com/auth/gmail.settings.basic',
        'sheets https://www.googleapis.com/auth/spreadsheets',
        'docs https://www.googleapis.com/auth/documents',
        'calendar https://www.googleapis.com/auth/calendar.events',
        'tasks https://www.googleapis.com/auth/tasks',
        // Slack's seven, which arrived when its scopes moved off a setup page
        // and into the manifest. Nothing widened to put them here: this is the
        // same grant the setup page asked the operator to transcribe, now
        // somewhere it can be shown before consent rather than after.
        //
        // Six of the seven are one argument — Slack draws no line between
        // "read a conversation" and "read a private conversation", so the
        // history and search scopes for private channels, DMs, and group DMs
        // each reach the most sensitive thing in a workspace while reading like
        // routine access. `chat:write` is the seventh and the only write:
        // messages it sends are from the person, not from an app, and there is
        // nothing in Slack's UI that says otherwise afterwards.
        'slack search:read.private',
        'slack search:read.im',
        'slack search:read.mpim',
        'slack groups:history',
        'slack im:history',
        'slack mpim:history',
        'slack chat:write',
        // Reddit's three, and all three for one reason: they act publicly under
        // the person's username. Everything above is broad for how much it
        // reaches inside a private space; these are broad for being visible
        // outside one, which is the other way a grant can be more than it
        // sounds.
        //
        // They are also the only writes here that cannot be taken back.
        // Deleting a post leaves the deletion behind, and anything quoted,
        // cached, or replied to in the meantime stays — so "post as you" is
        // nearer to publishing than to writing. `read` is deliberately not on
        // this list: it reaches only what the account can already see, and what
        // Reddit makes readable is public to begin with.
        'reddit submit',
        'reddit edit',
        'reddit vote',
      ].sort(),
    );
  });
});
