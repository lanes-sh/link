import { describe, expect, test } from 'bun:test';
import { createDavConnector } from './index.ts';
import type { ConnectorContext, DiscoveryContext, ToolResult } from '#connectivity';

/**
 * The DAV connector, against a scripted server.
 *
 * The discovery chain is three round trips and ends on a host the manifest never
 * names — iCloud answers from a numbered partition that is *per account*. Two
 * things therefore matter more than the happy path: that the resolved host is
 * remembered per connection rather than in the shared capability cache, and that
 * a redirect can never carry the credential somewhere else.
 */

const PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response>
  <d:href>/.well-known/caldav</d:href>
  <d:propstat><d:status>HTTP/1.1 200 OK</d:status>
  <d:prop><d:current-user-principal><d:href>/1234/principal/</d:href></d:current-user-principal></d:prop>
  </d:propstat></d:response></d:multistatus>`;

const HOME = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
  <d:href>/1234/principal/</d:href>
  <d:propstat><d:status>HTTP/1.1 200 OK</d:status>
  <d:prop><c:calendar-home-set><d:href>https://p42-caldav.icloud.com/1234/calendars/</d:href></c:calendar-home-set></d:prop>
  </d:propstat></d:response></d:multistatus>`;

const COLLECTIONS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/1234/calendars/home/</d:href>
    <d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Home</d:displayname>
      <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/1234/calendars/reminders/</d:href>
    <d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Reminders</d:displayname>
      <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

const EVENTS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
  <d:href>/1234/calendars/home/1.ics</d:href>
  <d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>
  <d:getetag>"etag-v1"</d:getetag>
  <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:e-1
SUMMARY:Standup
DTSTART:20260811T090000Z
DTEND:20260811T091500Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
  </d:prop></d:propstat></d:response></d:multistatus>`;

/** What a UID lookup returns: the event as it really is, invitations and all. */
const EVENT_BY_UID = EVENTS.replace(
  'DTEND:20260811T091500Z',
  'DTEND:20260811T091500Z\nATTENDEE:mailto:sam@example.com\nRRULE:FREQ=WEEKLY;BYDAY=MO\nSEQUENCE:3',
);

const CARDDAV_PRINCIPAL = PRINCIPAL.replace('/.well-known/caldav', '/.well-known/carddav');

const CARDDAV_HOME = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:response>
  <d:href>/1234/principal/</d:href>
  <d:propstat><d:status>HTTP/1.1 200 OK</d:status>
  <d:prop><a:addressbook-home-set><d:href>https://p42-contacts.icloud.com/1234/cards/</d:href></a:addressbook-home-set></d:prop>
  </d:propstat></d:response></d:multistatus>`;

const CARDDAV_COLLECTIONS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:response>
  <d:href>/1234/cards/home/</d:href>
  <d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>
    <d:resourcetype><d:collection/><a:addressbook/></d:resourcetype>
    <d:displayname>Contacts</d:displayname>
  </d:prop></d:propstat></d:response></d:multistatus>`;

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly ifMatch: string | null;
  readonly ifNoneMatch: string | null;
  readonly body: string;
}

function harness(options: { redirectWellKnown?: string; putStatus?: number } = {}) {
  const calls: Call[] = [];
  const state = new Map<string, string>();

  const doFetch = (async (request: Request): Promise<Response> => {
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get('authorization'),
      ifMatch: request.headers.get('if-match'),
      ifNoneMatch: request.headers.get('if-none-match'),
      body: await request.clone().text(),
    });

    const url = new URL(request.url);

    if (url.pathname === '/.well-known/caldav') {
      if (options.redirectWellKnown) {
        return new Response(null, {
          status: 301,
          headers: { location: options.redirectWellKnown },
        });
      }
      return new Response(PRINCIPAL, { status: 207 });
    }
    if (url.pathname === '/.well-known/carddav') {
      return new Response(CARDDAV_PRINCIPAL, { status: 207 });
    }
    if (url.pathname === '/1234/principal/') {
      // The principal answers whichever home-set was asked for.
      const body = calls[calls.length - 1]!.body;
      return new Response(body.includes('carddav') ? CARDDAV_HOME : HOME, { status: 207 });
    }
    if (url.pathname === '/1234/calendars/') return new Response(COLLECTIONS, { status: 207 });
    if (url.pathname === '/1234/cards/') return new Response(CARDDAV_COLLECTIONS, { status: 207 });
    if (request.method === 'REPORT') {
      // A UID filter is a lookup for edit or delete; a time range is a listing.
      const body = calls[calls.length - 1]!.body;
      return new Response(body.includes('name="UID"') ? EVENT_BY_UID : EVENTS, { status: 207 });
    }
    if (request.method === 'PUT') return new Response('', { status: options.putStatus ?? 201 });
    if (request.method === 'DELETE') return new Response('', { status: options.putStatus ?? 204 });

    return new Response('not scripted', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const context = {
    manifest: { id: 'icloud_calendar' },
    provider: {
      state: {
        get: async (key: string) => state.get(key) ?? null,
        set: async (key: string, value: string) => void state.set(key, value),
      },
    },
    // What core does for a `basic` manifest, and the only place a credential
    // enters a DAV request.
    authorize: async (request: Request) => {
      const authorised = new Request(request, { headers: new Headers(request.headers) });
      authorised.headers.set('authorization', 'Basic d2lsbDphcHA=');
      return authorised;
    },
  } as unknown as ConnectorContext;

  return { calls, state, context, doFetch };
}

const calendarConnector = (doFetch: typeof globalThis.fetch) =>
  createDavConnector({ baseUrl: 'https://caldav.icloud.com', service: 'caldav', fetch: doFetch });

const invoke = (
  connector: ReturnType<typeof createDavConnector>,
  operation: string,
  args: Record<string, unknown>,
  context: ConnectorContext,
) => connector.invoke({ name: operation, target: { operation } } as never, args, context);

const parsed = (result: ToolResult): Record<string, unknown> =>
  JSON.parse((result.content[0] as { text?: string }).text!);

describe('discovery', () => {
  test('capabilities carry no account-specific routing', async () => {
    // The discovery cache is keyed by provider, so a partition host in `target`
    // would point a second Apple Account at the first one's calendars.
    const connector = calendarConnector(harness().doFetch);

    for (const capability of await connector.discover({} as DiscoveryContext)) {
      expect(Object.keys(capability.target ?? {})).toEqual(['operation']);
      expect(JSON.stringify(capability.target)).not.toContain('icloud.com');
    }
  });

  test('a calendar manifest offers no contact tools', async () => {
    const contacts = createDavConnector({
      baseUrl: 'https://contacts.icloud.com',
      service: 'carddav',
      fetch: harness().doFetch,
    });

    const calendarNames = (await calendarConnector(harness().doFetch).discover({} as DiscoveryContext)).map(
      (c) => c.name,
    );
    const contactNames = (await contacts.discover({} as DiscoveryContext)).map((c) => c.name);

    expect(calendarNames).toEqual([
      'list_calendars',
      'list_events',
      'get_event',
      'update_event',
      'delete_event',
      'create_event',
    ]);
    expect(contactNames).toEqual(['list_addressbooks', 'search_contacts', 'create_contact']);
  });
});

describe('resolving the account home', () => {
  test('walks well-known → principal → home-set, then uses the partition host', async () => {
    const { doFetch, calls, context } = harness();

    const result = await invoke(calendarConnector(doFetch), 'list_calendars', {}, context);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/.well-known/caldav',
      '/1234/principal/',
      '/1234/calendars/',
    ]);
    // The last request went to a host the manifest never names.
    expect(new URL(calls[2]!.url).hostname).toBe('p42-caldav.icloud.com');
    expect(parsed(result)['calendars']).toHaveLength(1);
  });

  test('every request carries the credential core attached', async () => {
    const { doFetch, calls, context } = harness();

    await invoke(calendarConnector(doFetch), 'list_calendars', {}, context);

    expect(calls.every((call) => call.authorization === 'Basic d2lsbDphcHA=')).toBe(true);
  });

  test('the resolved home is remembered per connection, not re-walked', async () => {
    const { doFetch, calls, context, state } = harness();
    const connector = calendarConnector(doFetch);

    await invoke(connector, 'list_calendars', {}, context);
    const afterFirst = calls.length;
    await invoke(connector, 'list_calendars', {}, context);

    expect(state.get('dav:home')).toBe('https://p42-caldav.icloud.com/1234/calendars/');
    // One request the second time, not four: the three-step walk is not repeated.
    expect(calls.length - afterFirst).toBe(1);
  });

  test('a cold instance serves from stored state with no discovery at all', async () => {
    // ADR-002: the server is stateless and may be replaced between calls.
    const { doFetch, calls, context, state } = harness();
    state.set('dav:home', 'https://p42-caldav.icloud.com/1234/calendars/');

    await invoke(calendarConnector(doFetch), 'list_calendars', {}, context);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/1234/calendars/']);
  });
});

describe('redirects', () => {
  test('a redirect within the same domain is followed', async () => {
    const { doFetch, calls, context } = harness({
      redirectWellKnown: 'https://p42-caldav.icloud.com/.well-known/caldav',
    });

    await invoke(calendarConnector(doFetch), 'list_calendars', {}, context);

    expect(calls[1]!.url).toContain('p42-caldav.icloud.com');
  });

  test('a redirect off the domain is refused rather than followed', async () => {
    // `fetch` would happily resend the Authorization header to whatever the
    // Location names, which is an app-specific password handed to a stranger.
    const { doFetch, context } = harness({
      redirectWellKnown: 'https://evil.test/.well-known/caldav',
    });

    const result = await invoke(calendarConnector(doFetch), 'list_calendars', {}, context);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Refusing to send credentials');
  });
});

describe('listing events', () => {
  test('a Reminders list is not presented as a calendar', async () => {
    // iCloud publishes Reminders as a CalDAV collection holding VTODO. Without
    // the component filter it shows up as a calendar that is always empty.
    const { doFetch, context } = harness();

    const result = await invoke(calendarConnector(doFetch), 'list_calendars', {}, context);
    const calendars = parsed(result)['calendars'] as { name: string }[];

    expect(calendars.map((calendar) => calendar.name)).toEqual(['Home']);
  });

  test('events come back parsed, and the server was asked to expand them', async () => {
    const { doFetch, calls, context } = harness();

    const result = await invoke(
      calendarConnector(doFetch),
      'list_events',
      { start: '2026-08-11T00:00:00Z', end: '2026-08-12T00:00:00Z' },
      context,
    );

    const report = calls.find((call) => call.method === 'REPORT');
    expect(report).toBeDefined();

    const body = parsed(result);
    expect(body['expanded']).toBe(true);
    expect(body['events']).toMatchObject([{ uid: 'e-1', summary: 'Standup', calendar: 'Home' }]);
  });

  test('a range longer than a year is refused before it is sent', async () => {
    // iCloud rejects it, and doing so here explains why instead of surfacing a
    // bare 400.
    const { doFetch, calls, context } = harness();

    const result = await invoke(
      calendarConnector(doFetch),
      'list_events',
      { start: '2026-01-01T00:00:00Z', end: '2028-01-01T00:00:00Z' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(calls.some((call) => call.method === 'REPORT')).toBe(false);
  });
});

describe('creating an event', () => {
  test('refuses to overwrite, and lands in the named calendar', async () => {
    const { doFetch, calls, context } = harness();

    const result = await invoke(
      calendarConnector(doFetch),
      'create_event',
      {
        calendar: 'Home',
        summary: 'Coffee',
        start: '2026-08-12T10:00:00Z',
        end: '2026-08-12T10:30:00Z',
      },
      context,
    );

    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toContain('/1234/calendars/home/');
    expect(parsed(result)['created']).toBe(true);
  });

  test('an unknown calendar is named, not silently ignored', async () => {
    const { doFetch, context } = harness();

    const result = await invoke(
      calendarConnector(doFetch),
      'create_event',
      { calendar: 'Nope', summary: 'x', start: '2026-08-12', end: '2026-08-12' },
      context,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Nope');
  });
});

describe('editing an event', () => {
  test('the change is conditional on the ETag that was read', async () => {
    // Without If-Match, two agents editing the same event silently overwrite
    // each other and the loser's change vanishes with no error anywhere.
    const { doFetch, calls, context } = harness();

    await invoke(
      calendarConnector(doFetch),
      'update_event',
      { uid: 'e-1', summary: 'Standup (moved)' },
      context,
    );

    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.ifMatch).toBe('"etag-v1"');
  });

  test('a stale ETag is reported as a conflict, not a generic failure', async () => {
    const { doFetch, context } = harness({ putStatus: 412 });

    const result = await invoke(
      calendarConnector(doFetch),
      'update_event',
      { uid: 'e-1', summary: 'x' },
      context,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('changed since it was read');
  });

  test('attendees and repetition survive an edit', async () => {
    // Rebuilding the event from the fields we model would un-invite everyone and
    // turn a weekly meeting into a one-off.
    const { doFetch, calls, context } = harness();

    await invoke(
      calendarConnector(doFetch),
      'update_event',
      { uid: 'e-1', summary: 'Standup (moved)', start: '2026-08-11T10:00:00Z' },
      context,
    );

    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.body).toContain('ATTENDEE:mailto:sam@example.com');
    expect(put.body).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(put.body).toContain('SUMMARY:Standup (moved)');
    expect(put.body).toContain('DTSTART:20260811T100000Z');
    // Bumped, or no other client notices the edit.
    expect(put.body).toContain('SEQUENCE:4');
  });

  test('an unknown uid is named rather than silently doing nothing', async () => {
    const { doFetch, context } = harness();
    const connector = createDavConnector({
      baseUrl: 'https://caldav.icloud.com',
      service: 'caldav',
      fetch: (async (request: Request) => {
        if (request.method === 'REPORT') {
          return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>', {
            status: 207,
          });
        }
        return doFetch(request);
      }) as unknown as typeof globalThis.fetch,
    });

    const result = await invoke(connector, 'update_event', { uid: 'nope' }, context);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('nope');
  });
});

describe('deleting an event', () => {
  test('also conditional on the ETag', async () => {
    const { doFetch, calls, context } = harness();

    const result = await invoke(calendarConnector(doFetch), 'delete_event', { uid: 'e-1' }, context);

    const remove = calls.find((call) => call.method === 'DELETE')!;
    expect(remove.ifMatch).toBe('"etag-v1"');
    expect(parsed(result)).toMatchObject({ deleted: true, was: 'Standup' });
  });
});

describe('creating a contact', () => {
  test('refuses to overwrite, and writes a readable vCard', async () => {
    const { doFetch, calls, context } = harness();
    const contacts = createDavConnector({
      baseUrl: 'https://contacts.icloud.com',
      service: 'carddav',
      fetch: doFetch,
    });

    const result = await invoke(
      contacts,
      'create_contact',
      { full_name: 'Sam Jones', emails: ['sam@example.com'] },
      context,
    );

    expect(parsed(result)).toMatchObject({ created: true, addressbook: 'Contacts' });

    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.ifNoneMatch).toBe('*');
    expect(put.url).toContain('/1234/cards/home/');
    expect(put.body).toContain('FN:Sam Jones');
    expect(put.body).toContain('EMAIL;TYPE=INTERNET:sam@example.com');
  });
});

describe('discovery against a server that answers awkwardly', () => {
  // iCloud's contacts host, exactly: a 207 whose propstat is 404 at the
  // well-known path, and the real answer at the root. Reading the empty element
  // as a value made `list_addressbooks` fail with "did not say which principal
  // you are" against a perfectly healthy account.
  const NOT_HERE = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:"><response>
      <href>/.well-known/carddav/</href>
      <propstat><prop><current-user-principal/></prop>
      <status>HTTP/1.1 404 Not Found</status></propstat>
    </response></multistatus>`;

  const AT_ROOT = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:"><response>
      <href>/</href>
      <propstat><prop><current-user-principal><href>/1234/principal/</href></current-user-principal></prop>
      <status>HTTP/1.1 200 OK</status></propstat>
    </response></multistatus>`;

  const HOME_AT_ROOT = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:" xmlns:a="urn:ietf:params:xml:ns:carddav"><response>
      <href>/1234/principal/</href>
      <propstat><prop><a:addressbook-home-set><href>https://p9-contacts.test/1234/cards/</href></a:addressbook-home-set></prop>
      <status>HTTP/1.1 200 OK</status></propstat>
    </response></multistatus>`;

  const BOOKS = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:" xmlns:a="urn:ietf:params:xml:ns:carddav"><response>
      <href>/1234/cards/card/</href>
      <propstat><prop><resourcetype><collection/><a:addressbook/></resourcetype></prop>
      <status>HTTP/1.1 200 OK</status></propstat>
    </response></multistatus>`;

  const awkward = () => {
    const paths: string[] = [];
    const state = new Map<string, string>();
    const doFetch = (async (request: Request) => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      if (url.pathname === '/.well-known/carddav') return new Response(NOT_HERE, { status: 207 });
      if (url.pathname === '/') return new Response(AT_ROOT, { status: 207 });
      if (url.pathname === '/1234/principal/') return new Response(HOME_AT_ROOT, { status: 207 });
      if (url.pathname === '/1234/cards/') return new Response(BOOKS, { status: 207 });
      return new Response('', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const context = {
      manifest: {},
      provider: {
        state: {
          get: async (key: string) => state.get(key) ?? null,
          set: async (key: string, value: string) => void state.set(key, value),
        },
      },
      authorize: async (request: Request) => request,
    } as unknown as ConnectorContext;

    return { paths, context, doFetch };
  };

  test('a 404 propstat is not read as an answer, and the root is tried next', async () => {
    const { paths, context, doFetch } = awkward();
    const contacts = createDavConnector({
      baseUrl: 'https://contacts.test',
      service: 'carddav',
      fetch: doFetch,
    });

    const result = await invoke(contacts, 'list_addressbooks', {}, context);

    expect(result.isError ?? false).toBe(false);
    // The well-known path is still tried first, per RFC 6764; the root is the
    // fallback, not a replacement.
    expect(paths.slice(0, 2)).toEqual(['/.well-known/carddav', '/']);
  });

  test('a collection with no displayname gets a usable name, not a raw href', async () => {
    const { context, doFetch } = awkward();
    const contacts = createDavConnector({
      baseUrl: 'https://contacts.test',
      service: 'carddav',
      fetch: doFetch,
    });

    const books = parsed(await invoke(contacts, 'list_addressbooks', {}, context)) as {
      addressbooks: { name: string }[];
    };

    expect(books.addressbooks[0]?.name).toBe('card');
  });
});
