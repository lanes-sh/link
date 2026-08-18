import { defineProvider } from '#connectivity';
import { ICLOUD_APP, icloudSetup } from '../shared/setup.ts';

export const icloudCalendar = defineProvider({
  id: 'icloud_calendar',
  name: 'iCloud Calendar',
  description: 'Read and create events in iCloud calendars over CalDAV.',
  connector: {
    kind: 'dav',
    base_url: 'https://caldav.icloud.com',
    service: 'caldav',
    // Apple's limit, declared rather than assumed by the transport.
    max_range_days: 366,
  },
  auth: { kind: 'basic', app: ICLOUD_APP },
  identity: { kind: 'connector' },
  setup: icloudSetup('iCloud Calendar'),
  redact: {
    list_events: ['calendar', 'start', 'end', 'limit'],
    get_event: ['calendar', 'uid'],
    // The uid and calendar say *which* event changed, which is what makes the
    // log worth having; the summary and location are the content of it.
    update_event: ['calendar', 'uid'],
    delete_event: ['calendar', 'uid'],
    create_event: ['calendar'],
  },
});
