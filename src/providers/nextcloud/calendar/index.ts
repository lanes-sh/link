import { defineProvider } from '#connectivity';
import { NEXTCLOUD_APP, NEXTCLOUD_HOST, nextcloudSetup } from '../shared/setup.ts';

/**
 * Nextcloud calendars, on whichever server the operator runs.
 *
 * The first built-in whose address is not a property of the provider. Until a
 * connection could carry one, a self-hosted service could only be reached by
 * hand-writing a YAML manifest per instance — which worked, and which nobody
 * discovers. See ADR-055.
 */
export const nextcloudCalendar = defineProvider({
  id: 'nextcloud_calendar',
  name: 'Nextcloud Calendar',
  description: 'Read and create events in Nextcloud calendars over CalDAV, on your own server.',
  connector: { kind: 'dav', base_url: 'https://{host}', service: 'caldav' },
  auth: { kind: 'basic', app: NEXTCLOUD_APP },
  identity: { kind: 'connector' },
  variables: [NEXTCLOUD_HOST],
  setup: nextcloudSetup('Nextcloud Calendar'),
  redact: {
    list_events: ['calendar', 'start', 'end', 'limit'],
    get_event: ['calendar', 'uid'],
    update_event: ['calendar', 'uid'],
    delete_event: ['calendar', 'uid'],
    create_event: ['calendar'],
  },
});
