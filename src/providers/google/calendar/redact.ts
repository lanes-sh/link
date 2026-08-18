/**
 * What survives into the audit log when an event is read or changed.
 *
 * The generated tools flatten a request body into top-level arguments, so
 * `summary`, `description`, `location`, and `attendees` really are argument
 * names here — and they are the meeting. Keeping them would put "1:1 re
 * redundancy consultation" and the list of who was invited in a log meant to
 * record that a change happened, not to hold a second copy of the calendar.
 *
 * `sendUpdates` is kept on every write, and it is the one flag worth reading
 * back: cancelling a meeting quietly and cancelling it with mail to everyone
 * invited are different acts, and only this argument tells them apart.
 *
 * `q` is withheld on Gmail's reasoning — a search is a question, and "who am I
 * meeting about the redundancy" is content whoever typed it did not expect to
 * keep. `freebusy.query`'s `items` is withheld on the same ground, which is the
 * one call worth explaining: `calendarId` is kept everywhere else because it
 * names the resource being read or written, but a `freeBusy` `items` list is a
 * set of *people you asked about*. That is the query, not the subject.
 */
export const CALENDAR_REDACT: Record<string, string[]> = {
  'calendarList.list': ['minAccessRole', 'showHidden', 'maxResults'],
  'events.list': [
    'calendarId',
    'timeMin',
    'timeMax',
    'singleEvents',
    'orderBy',
    'maxResults',
    'showDeleted',
    'eventTypes',
  ],
  'events.get': ['calendarId', 'eventId'],
  'events.instances': ['calendarId', 'eventId', 'timeMin', 'timeMax', 'maxResults'],
  'freebusy.query': ['timeMin', 'timeMax', 'timeZone'],
  'events.insert': ['calendarId', 'sendUpdates', 'conferenceDataVersion'],
  'events.patch': ['calendarId', 'eventId', 'sendUpdates'],
  'events.delete': ['calendarId', 'eventId', 'sendUpdates'],
  'events.move': ['calendarId', 'eventId', 'destination', 'sendUpdates'],
};
