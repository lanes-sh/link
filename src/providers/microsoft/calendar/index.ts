import { defineProvider } from '#connectivity';
import {
  CALENDAR_SCOPES,
  CONTACTS_SCOPES,
  FILES_SCOPES,
  GRAPH_BASE_URL,
  MAIL_SCOPES,
  MICROSOFT_APP,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_IDENTITY,
  MICROSOFT_TOKEN_URL,
  TODO_SCOPES,
  specPath,
} from '../shared/oauth.ts';
import { microsoftSetup } from '../shared/setup.ts';

export const outlookCalendar = defineProvider({
  id: 'outlook_calendar',
  name: 'Outlook Calendar',
  description:
    'Read and write events in Outlook calendars — list, search, create, reschedule, and cancel — via Microsoft Graph.',
  connector: { kind: 'http', base_url: GRAPH_BASE_URL, openapi: specPath('outlook-calendar.v1.json') },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: MICROSOFT_APP,
    // Declared rather than discovered. An `http` connector has no metadata
    // document to read — a REST API does not announce where its authorization
    // server lives — so the two endpoints are part of the manifest.
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_url: MICROSOFT_TOKEN_URL,
    scopes: CALENDAR_SCOPES,
    revoke_url: 'https://account.live.com/consent/Manage',
  },
  identity: MICROSOFT_IDENTITY,
  setup: microsoftSetup('Outlook Calendar', CALENDAR_SCOPES),
  redact: {
    'me.ListCalendars': ['top', 'orderby', 'select'],
    'me.ListEvents': ['top', 'orderby', 'select'],
    // The window is not content; what is in it is.
    'me.ListCalendarView': ['startDateTime', 'endDateTime', 'top', 'orderby', 'select'],
    'me.GetEvents': ['event-id', 'select'],
    // The id says *which* event changed, which is what makes the log worth
    // having; the subject, the location, and the attendees are the content of it.
    'me.CreateEvents': ['isAllDay', 'showAs'],
    'me.UpdateEvents': ['event-id', 'isAllDay', 'showAs'],
    'me.DeleteEvents': ['event-id'],
  },
});
