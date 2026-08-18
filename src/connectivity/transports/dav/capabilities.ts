import { READ_BUNDLE, WRITE_BUNDLE, type DiscoveredCapability } from '#connectivity';
import { DEFAULT_MAX_RANGE_DAYS, OPERATIONS, object } from './operations.ts';

/**
 * What a DAV connection exposes, as data.
 *
 * Fixed, like `imap`: WebDAV describes collections, never operations. The list
 * is conditioned on the service so a manifest pointing at a calendar never
 * shows contact tools.
 *
 * Extracted from `discover()` because it is a hundred and thirty lines of
 * declaration wrapped around three lines of behaviour, and reading the
 * behaviour meant scrolling past all of it.
 */
export function davCapabilities(service: 'caldav' | 'carddav'): DiscoveredCapability[] {
  const calendar = service === 'caldav';

  return calendar
        ? [
            {
              name: OPERATIONS.listCalendars,
              description: 'List the calendars in the account.',
              bundle: READ_BUNDLE,
              inputSchema: object({}),
              target: { operation: OPERATIONS.listCalendars },
            },
            {
              name: OPERATIONS.listEvents,
              description:
                'Events between two dates, with repeating events already expanded into instances.',
              bundle: READ_BUNDLE,
              inputSchema: object(
                {
                  calendar: {
                    type: 'string',
                    description: 'Calendar name from list_calendars. Defaults to every calendar.',
                  },
                  start: { type: 'string', description: 'ISO 8601 date or date-time.' },
                  end: {
                    type: 'string',
                    description: `ISO 8601. At most ${DEFAULT_MAX_RANGE_DAYS} days after start.`,
                  },
                  limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                },
                ['start', 'end'],
              ),
              target: { operation: OPERATIONS.listEvents },
            },
            {
              name: OPERATIONS.getEvent,
              description: 'One event by its UID, optionally with its raw iCalendar text.',
              bundle: READ_BUNDLE,
              inputSchema: object(
                {
                  calendar: { type: 'string' },
                  uid: { type: 'string', description: 'UID as list_events reports it.' },
                  include_raw: { type: 'boolean', default: false },
                },
                ['uid'],
              ),
              target: { operation: OPERATIONS.getEvent },
            },
            {
              name: OPERATIONS.updateEvent,
              description:
                'Change an existing event. Only the fields you pass are touched; attendees, alarms and repetition are preserved.',
              bundle: WRITE_BUNDLE,
              inputSchema: object(
                {
                  calendar: { type: 'string' },
                  uid: { type: 'string' },
                  summary: { type: 'string' },
                  start: { type: 'string', description: 'ISO 8601 date or date-time.' },
                  end: { type: 'string', description: 'ISO 8601 date or date-time.' },
                  all_day: { type: 'boolean' },
                  location: { type: 'string', description: 'Empty string clears it.' },
                  description: { type: 'string', description: 'Empty string clears it.' },
                },
                ['uid'],
              ),
              target: { operation: OPERATIONS.updateEvent },
            },
            {
              name: OPERATIONS.deleteEvent,
              description: 'Delete an event. This goes to the calendar\'s trash, not permanently.',
              bundle: WRITE_BUNDLE,
              inputSchema: object(
                { calendar: { type: 'string' }, uid: { type: 'string' } },
                ['uid'],
              ),
              target: { operation: OPERATIONS.deleteEvent },
            },
            {
              name: OPERATIONS.createEvent,
              description: 'Create an event in a calendar.',
              bundle: WRITE_BUNDLE,
              inputSchema: object(
                {
                  calendar: { type: 'string' },
                  summary: { type: 'string' },
                  start: { type: 'string', description: 'ISO 8601 date or date-time.' },
                  end: { type: 'string', description: 'ISO 8601 date or date-time.' },
                  all_day: { type: 'boolean', default: false },
                  location: { type: 'string' },
                  description: { type: 'string' },
                },
                ['calendar', 'summary', 'start', 'end'],
              ),
              target: { operation: OPERATIONS.createEvent },
            },
          ]
        : [
            {
              name: OPERATIONS.listAddressbooks,
              description: 'List the address books in the account.',
              bundle: READ_BUNDLE,
              inputSchema: object({}),
              target: { operation: OPERATIONS.listAddressbooks },
            },
            {
              name: OPERATIONS.searchContacts,
              description: 'Search contacts by name or email address.',
              bundle: READ_BUNDLE,
              inputSchema: object(
                {
                  query: { type: 'string', description: 'Matched against name and email.' },
                  limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                },
                ['query'],
              ),
              target: { operation: OPERATIONS.searchContacts },
            },
            {
              name: OPERATIONS.createContact,
              description: 'Add a contact to an address book.',
              bundle: WRITE_BUNDLE,
              inputSchema: object(
                {
                  addressbook: { type: 'string', description: 'Defaults to the first one.' },
                  full_name: { type: 'string' },
                  emails: { type: 'array', items: { type: 'string' } },
                  phones: { type: 'array', items: { type: 'string' } },
                  organization: { type: 'string' },
                  note: { type: 'string' },
                },
                ['full_name'],
              ),
              target: { operation: OPERATIONS.createContact },
            },
          ];
}
