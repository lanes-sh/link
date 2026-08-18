/**
 * The operation names a DAV connection exposes, and the two constants that
 * shape them.
 *
 * Their own file because `capabilities.ts` declares them and `index.ts`
 * dispatches on them: a name spelled differently in the two places is a tool
 * that lists and cannot be called, which is exactly the failure a shared
 * constant prevents.
 */

export const OPERATIONS = {
  listCalendars: 'list_calendars',
  listEvents: 'list_events',
  getEvent: 'get_event',
  createEvent: 'create_event',
  updateEvent: 'update_event',
  deleteEvent: 'delete_event',
  listAddressbooks: 'list_addressbooks',
  searchContacts: 'search_contacts',
  createContact: 'create_contact',
} as const;

/** Where the resolved, account-specific collection home is remembered. */
export const HOME_KEY = 'dav:home';

/**
 * Default `list_events` window, when a provider declares none.
 *
 * Every DAV server slows down over a year of expanded recurrences, so there is
 * a bound rather than none. Which bound is a *server* fact, so a provider that
 * knows its own says so — see `max_range_days` on the connector schema.
 */
export const DEFAULT_MAX_RANGE_DAYS = 366;

export const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
