import type { ToolResult } from '#connectivity';
import { buildEvent, compact, parseEvents, patchEvent } from './ical.ts';
import { error, json } from './request.ts';
import { CALDAV, DAV, escapeXml, findAll, parseDav, textOf } from './xml.ts';
import type { DavClient } from './client.ts';

/**
 * CalDAV's five operations.
 *
 * Free functions over a `DavClient` rather than methods on it, so the class
 * stays the transport and the feature set stays readable — the two halves were
 * a 440-line class where the plumbing and the calendar semantics were
 * interleaved.
 */

export async function listEvents(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const start = String(args['start'] ?? '');
    const end = String(args['end'] ?? '');
    if (!start || !end) return error('start and end are required.');

    const maxDays = dav.maxRangeDays;
    const span = Date.parse(end) - Date.parse(start);
    if (Number.isFinite(span) && span > maxDays * 86_400_000) {
      return error(
        `That range is longer than ${maxDays} days, which this server refuses. Ask for a narrower window.`,
      );
    }

    const limit = Math.min(Number(args['limit'] ?? 50) || 50, 200);
    const wanted = args['calendar'] ? String(args['calendar']) : undefined;

    const calendars = (await dav.collections()).filter(
      (collection) => !wanted || collection.name === wanted,
    );
    if (calendars.length === 0) {
      return error(wanted ? `No calendar named "${wanted}".` : 'No calendars in this account.');
    }

    const from = compact(start);
    const to = compact(end);

    // `<C:expand>` asks the *server* to turn repeating events into instances,
    // which is the whole reason there is no recurrence engine in this codebase.
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}">` +
      `<d:prop><d:getetag/>` +
      `<c:calendar-data><c:expand start="${from}" end="${to}"/></c:calendar-data>` +
      `</d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR">` +
      `<c:comp-filter name="VEVENT"><c:time-range start="${from}" end="${to}"/></c:comp-filter>` +
      `</c:comp-filter></c:filter></c:calendar-query>`;

    const events: unknown[] = [];
    let expanded = true;

    for (const collection of calendars) {
      const result = await dav.request(collection.href, 'REPORT', body, { depth: '1' });
      if (result.status >= 400) continue;

      for (const response of findAll(parseDav(result.text), `{${DAV}}response`)) {
        const data = textOf(response, `{${CALDAV}}calendar-data`);
        if (!data) continue;

        for (const event of parseEvents(data)) {
          // A surviving RRULE means the server ignored `<C:expand>`; say so
          // rather than presenting a master event as if it were an instance.
          if (event.recurrence_rule) expanded = false;
          events.push({ ...event, calendar: collection.name });
        }
      }
    }

    events.sort((a, b) =>
      String((a as { start?: string }).start ?? '').localeCompare(
        String((b as { start?: string }).start ?? ''),
      ),
    );

    return json({
      range: { start, end },
      expanded,
      ...(expanded
        ? {}
        : { note: 'This server did not expand repeating events; those carry recurrence_rule.' }),
      events: events.slice(0, limit),
    });
  }

export async function createEvent(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const name = String(args['calendar'] ?? '');
    const collection = (await dav.collections()).find((entry) => entry.name === name);
    if (!collection) return error(`No calendar named "${name}".`);

    const uid = `${crypto.randomUUID()}@lanes-link`;
    const ical = buildEvent({
      uid,
      summary: String(args['summary'] ?? ''),
      start: String(args['start'] ?? ''),
      end: String(args['end'] ?? ''),
      allDay: args['all_day'] === true,
      location: args['location'] as string | undefined,
      description: args['description'] as string | undefined,
      timestamp: new Date().toISOString(),
    });

    const href = new URL(`${uid}.ics`, `${collection.href.replace(/\/?$/, '/')}`).href;

    const result = await dav.request(href, 'PUT', ical, {
      'content-type': 'text/calendar; charset=utf-8',
      // Refuse to overwrite: a UID collision means something is already there,
      // and silently replacing someone's event is not a create.
      'if-none-match': '*',
    });

    if (result.status >= 400) {
      return error(`The server refused the event (${result.status}). ${result.text.slice(0, 200)}`);
    }

    return json({ created: true, uid, calendar: name, href });
  }

  /**
   * Find one event by UID, and keep hold of its address and ETag.
   *
   * The ETag is the whole point. An edit is read-modify-write against a resource
   * two people may be holding, and `If-Match` is what turns a lost update into a
   * refusal — without it the second writer wins silently and the first one's
   * change is simply gone, with no error anywhere.
   */
export async function getEvent(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const uid = String(args['uid'] ?? '');
    const found = await dav.locate(uid, args['calendar'] ? String(args['calendar']) : undefined);
    if (!found) return error(`No event with UID "${uid}".`);

    const [event] = parseEvents(found.ical);
    if (!event) return error(`Entry "${uid}" contains no event.`);

    return json({
      ...event,
      calendar: found.calendar,
      ...(args['include_raw'] === true ? { raw: found.ical } : {}),
    });
  }

export async function updateEvent(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const uid = String(args['uid'] ?? '');
    const found = await dav.locate(uid, args['calendar'] ? String(args['calendar']) : undefined);
    if (!found) return error(`No event with UID "${uid}".`);

    const patched = patchEvent(found.ical, {
      summary: args['summary'] as string | undefined,
      start: args['start'] as string | undefined,
      end: args['end'] as string | undefined,
      allDay: args['all_day'] as boolean | undefined,
      location: args['location'] as string | undefined,
      description: args['description'] as string | undefined,
      timestamp: new Date().toISOString(),
    });

    const reply = await dav.request(found.href, 'PUT', patched, {
      'content-type': 'text/calendar; charset=utf-8',
      // Not optional. A server with no ETag to match on gets `*`, which at least
      // refuses to create where we meant to replace.
      'if-match': found.etag ?? '*',
    });

    if (reply.status === 412) {
      return error(
        `That event changed since it was read, so the edit was refused rather than overwriting someone else's. Read it again and retry.`,
      );
    }
    if (reply.status >= 400) {
      return error(`The server refused the edit (${reply.status}). ${reply.text.slice(0, 200)}`);
    }

    const [event] = parseEvents(patched);
    return json({ updated: true, uid, calendar: found.calendar, event });
  }

export async function deleteEvent(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const uid = String(args['uid'] ?? '');
    const found = await dav.locate(uid, args['calendar'] ? String(args['calendar']) : undefined);
    if (!found) return error(`No event with UID "${uid}".`);

    const reply = await dav.request(found.href, 'DELETE', undefined, {
      'if-match': found.etag ?? '*',
    });

    if (reply.status === 412) {
      return error(
        `That event changed since it was read, so the deletion was refused. Read it again and retry.`,
      );
    }
    if (reply.status >= 400) {
      return error(`The server refused the deletion (${reply.status}).`);
    }

    const [event] = parseEvents(found.ical);
    return json({ deleted: true, uid, calendar: found.calendar, was: event?.summary ?? null });
  }

