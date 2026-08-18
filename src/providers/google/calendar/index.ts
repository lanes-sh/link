import { defineProvider } from '#connectivity';
import { CALENDAR_IDENTITY, GOOGLE_APP, GOOGLE_OAUTH, specPath } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';
import { CALENDAR_REDACT } from './redact.ts';

/**
 * Read and write events without holding the calendar.
 *
 * Google splits Calendar the way it splits Drive, and here the split is usable.
 * `calendar.events` reaches every event on every calendar and reaches nothing
 * else: it cannot create a calendar, delete one, or change who it is shared
 * with. Those are `auth/calendar`, which is this provider's `mail.google.com`
 * and is not requested.
 *
 * `calendar.readonly` sits beside it and is not redundant. Two of the reads
 * accept nothing narrower — listing the calendars, and `freeBusy`, which is the
 * "when am I free" primitive and answers across calendars whose contents the
 * token may not read. Dropping it would cost the two operations an assistant
 * needs most.
 *
 * `calendar.events` is marked broad in `../shared/scopes.ts` and should stay
 * marked. Two narrower scopes do exist — `calendar.events.owned` and
 * `calendar.app.created`, Calendar's answer to `drive.file` — and neither is
 * usable: the vendored spec's per-operation `security` blocks name only the
 * scopes Google published when it was generated, so requesting one would fail
 * `specs.test.ts` and, more to the point, would fail at Google.
 * `calendar.app.created` also has the `drive.file` disease in a worse form — it
 * reaches only calendars this app made, and the calendar anyone means is the
 * primary one they already had.
 *
 * Note the `base_url`: Calendar carries its version in the host, like Drive
 * (`/calendar/v3` + `/calendars/{id}/events`). Copying the Sheets shape yields
 * `/v3/v3/...` and a 404 on every call.
 */
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export const calendar = defineProvider({
  id: 'calendar',
  name: 'Google Calendar',
  description:
    'Read and write calendar events — list, search, create, reschedule, and cancel — and answer when you are free, via the Calendar REST API.',
  connector: {
    kind: 'http',
    base_url: 'https://www.googleapis.com/calendar/v3',
    openapi: specPath('calendar.v3.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: CALENDAR_SCOPES,
    ...GOOGLE_OAUTH,
  },
  identity: CALENDAR_IDENTITY,
  setup: googleSetup('Calendar', CALENDAR_SCOPES, {
    // `calendar-json.googleapis.com`, not `calendar.googleapis.com`. The
    // service is registered under its discovery host, and enabling the
    // plausible-looking name leaves consent succeeding and every call
    // answering 403 — the failure this whole setup block exists to prevent.
    apis: ['calendar-json.googleapis.com'],
  }),
  redact: CALENDAR_REDACT,
});
