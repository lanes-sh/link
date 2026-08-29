import { defineProvider } from '#connectivity';
import { FASTMAIL_APP, fastmailSetup } from '../shared/setup.ts';

export const fastmailCalendar = defineProvider({
  id: 'fastmail_calendar',
  name: 'Fastmail Calendar',
  description: 'Read and create events in Fastmail calendars over CalDAV.',
  connector: { kind: 'dav', base_url: 'https://caldav.fastmail.com', service: 'caldav' },
  auth: { kind: 'basic', app: FASTMAIL_APP },
  identity: { kind: 'connector' },
  setup: fastmailSetup('Fastmail Calendar'),
  redact: {
    list_events: ['calendar', 'start', 'end', 'limit'],
    get_event: ['calendar', 'uid'],
    // The uid and calendar say *which* event changed; the summary and location
    // are the content of it.
    update_event: ['calendar', 'uid'],
    delete_event: ['calendar', 'uid'],
    create_event: ['calendar'],
  },
});
