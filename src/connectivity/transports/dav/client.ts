import type { ConnectorContext, ToolResult } from '#connectivity';
import { parseEvents } from './ical.ts';
import { PRINCIPAL_BODY, davRequest, hrefOfProperty, type DavReply } from './request.ts';
import { DEFAULT_MAX_RANGE_DAYS, HOME_KEY } from './operations.ts';
import {
  CALDAV,
  CARDDAV,
  DAV,
  escapeXml,
  find,
  findAll,
  parseDav,
  successful,
  textOf,
} from './xml.ts';
import type { Collection, DavConnectorOptions } from './index.ts';

/**
 * A DAV session for one connection.
 *
 * Holds the three things every operation needs and nothing else: how to make an
 * authorised request, where this account's collections live, and how to find a
 * single object by uid. `request`, `collections` and `locate` are public
 * because the calendar and contact operations are free functions in their own
 * files — the class is the transport, not the feature set.
 */
export class DavClient {
  constructor(
    private readonly options: DavConnectorOptions,
    private readonly doFetch: typeof globalThis.fetch,
    private readonly context: ConnectorContext,
  ) {}

  /** The longest event window this server will answer — the provider's fact. */
  get maxRangeDays(): number {
    return this.options.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;
  }

  private get calendar(): boolean {
    return this.options.service === 'caldav';
  }

  request(
    url: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<DavReply> {
    return davRequest(this.doFetch, (request: Request) => this.context.authorize(request), url, method, body, headers);
  }

  /**
   * The account's collection home, resolved once and remembered per connection.
   *
   * Three round trips — well-known, principal, home-set — which is why it is
   * cached; and cached in per-connection state rather than in the capability
   * target, because that cache is shared by every account of the provider.
   * Re-resolved whenever it is missing or has stopped working, so an Apple
   * partition migration heals itself instead of needing a re-connect.
   */
  private async home(): Promise<string> {
    const remembered = await this.context.provider.state.get(HOME_KEY);
    if (remembered) return remembered;

    const resolved = await this.resolveHome();
    await this.context.provider.state.set(HOME_KEY, resolved);
    return resolved;
  }

  private async resolveHome(): Promise<string> {
    const namespace = this.calendar ? CALDAV : CARDDAV;
    const property = this.calendar ? 'calendar-home-set' : 'addressbook-home-set';

    // Two places to ask, in order. RFC 6764's well-known path is a bootstrap
    // *hint*, and a server is free not to answer there — iCloud's contacts host
    // returns a 207 whose propstat is 404, which is "not here" wearing the
    // costume of a success. Falling back to the root is what every DAV client
    // does, and it is where iCloud actually answers.
    const candidates = [
      new URL(this.calendar ? '/.well-known/caldav' : '/.well-known/carddav', this.options.baseUrl)
        .href,
      new URL('/', this.options.baseUrl).href,
    ];

    let principalHref: string | undefined;
    let principalFoundAt: string | undefined;
    let lastStatus = 0;

    for (const candidate of candidates) {
      const reply = await this.request(candidate, 'PROPFIND', PRINCIPAL_BODY, { depth: '0' });
      lastStatus = reply.status;
      if (reply.status >= 400) continue;

      const href = hrefOfProperty(parseDav(reply.text), `{${DAV}}current-user-principal`);
      if (href) {
        principalHref = href;
        principalFoundAt = reply.url;
        break;
      }
    }

    if (lastStatus === 401 || lastStatus === 403) {
      throw new Error(
        `The server refused discovery (${lastStatus}).` +
          (this.options.troubleshooting ? ` ${this.options.troubleshooting}` : ''),
      );
    }
    if (!principalHref || !principalFoundAt) {
      throw new Error('The server did not say which principal you are.');
    }

    const principalUrl = new URL(principalHref, principalFoundAt).href;
    const homeBody =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:" xmlns:x="${namespace}">` +
      `<d:prop><x:${property}/></d:prop></d:propfind>`;

    const second = await this.request(principalUrl, 'PROPFIND', homeBody, { depth: '0' });
    const homeHref = hrefOfProperty(parseDav(second.text), `{${namespace}}${property}`);

    if (!homeHref) throw new Error('The server did not say where your collections live.');
    return new URL(homeHref, second.url).href;
  }

  /**
   * The collections in the home, filtered to the ones this service can use.
   *
   * The `VEVENT` filter is not cosmetic: iCloud publishes Reminders lists as
   * CalDAV collections holding `VTODO`, and without this they show up as
   * calendars that are always empty — which is Home Assistant's single
   * most-reported CalDAV complaint.
   */
  async collections(): Promise<Collection[]> {
    const namespace = this.calendar ? CALDAV : CARDDAV;
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:" xmlns:x="${namespace}">` +
      `<d:prop><d:resourcetype/><d:displayname/>` +
      (this.calendar ? `<x:supported-calendar-component-set/>` : '') +
      `</d:prop></d:propfind>`;

    const result = await this.request(await this.home(), 'PROPFIND', body, { depth: '1' });
    const responses = findAll(parseDav(result.text), `{${DAV}}response`);
    const collections: Collection[] = [];

    for (const response of responses) {
      const href = textOf(response, `{${DAV}}href`);
      if (!href) continue;

      const props = successful(response);
      if (props.length === 0) continue;

      const isRightType = props.some(
        (prop) =>
          findAll(prop, `{${namespace}}${this.calendar ? 'calendar' : 'addressbook'}`).length > 0,
      );
      if (!isRightType) continue;

      // A collection that declares its components but not VEVENT is a Reminders
      // list. Silence on the question is treated as "yes": some servers omit the
      // property entirely, and dropping those would hide real calendars.
      if (this.calendar) {
        const declared = props.some(
          (prop) => findAll(prop, `{${CALDAV}}supported-calendar-component-set`).length > 0,
        );
        const holdsEvents = props.some((prop) =>
          findAll(prop, `{${CALDAV}}comp`).some((comp) => comp.attributes['name'] === 'VEVENT'),
        );
        if (declared && !holdsEvents) continue;
      }

      collections.push({
        // A display name is optional, and iCloud omits it on the default
        // address book. The last path segment is a poor name but a usable one;
        // the whole href is neither, and this value is what a caller passes back
        // in as `calendar` or `addressbook`.
        name:
          props.map((prop) => textOf(prop, `{${DAV}}displayname`)).find(Boolean) ??
          href.split('/').filter(Boolean).pop() ??
          href,
        href: new URL(href, result.url).href,
      });
    }

    return collections;
  }

  async locate(
    uid: string,
    calendarName?: string,
  ): Promise<{ href: string; etag: string | undefined; ical: string; calendar: string } | null> {
    const escaped = escapeXml(uid);
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}">` +
      `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:prop-filter name="UID"><c:text-match collation="i;octet">${escaped}</c:text-match></c:prop-filter>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;

    const calendars = (await this.collections()).filter(
      (collection) => !calendarName || collection.name === calendarName,
    );

    for (const collection of calendars) {
      const reply = await this.request(collection.href, 'REPORT', body, { depth: '1' });
      if (reply.status >= 400) continue;

      for (const response of findAll(parseDav(reply.text), `{${DAV}}response`)) {
        const href = textOf(response, `{${DAV}}href`);
        const ical = textOf(response, `{${CALDAV}}calendar-data`);
        if (!href || !ical) continue;

        return {
          href: new URL(href, reply.url).href,
          etag: textOf(response, `{${DAV}}getetag`),
          ical,
          calendar: collection.name,
        };
      }
    }

    return null;
  }

}
