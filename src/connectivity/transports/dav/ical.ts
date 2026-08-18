/**
 * iCalendar (RFC 5545) and vCard (RFC 6350), to the depth this needs.
 *
 * Small on purpose. The genuinely hard part of RFC 5545 is recurrence — RRULE
 * with EXDATE, RECURRENCE-ID and VTIMEZONE — and **CalDAV lets the server do
 * it**: a `calendar-query` carrying `<C:expand>` returns instances already
 * expanded. What is left is mechanical and precisely specified: unfold
 * continuation lines, split `NAME;PARAM=value:VALUE`, unescape, and understand
 * three forms of date.
 *
 * That is why there is no `ical.js` here. It is 200 KB whose centrepiece is the
 * recurrence engine the protocol just did for us, under MPL-2.0 — a licence
 * nothing else in this tree carries.
 *
 * Where a server ignores `<C:expand>`, the caller reports `expanded: false` and
 * hands back the RRULE verbatim. Degrading honestly beats expanding wrongly.
 */

export interface ContentLine {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/**
 * Unfold and split a whole document into lines.
 *
 * Unfolding first, and it must be first: a line beginning with a space or tab is
 * a continuation of the previous one, and a long `SUMMARY` is routinely folded
 * mid-word at 75 octets.
 */
export function parseLines(text: string): ContentLine[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');

  return unfolded
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map(parseLine)
    .filter((line): line is ContentLine => line !== null);
}

function parseLine(line: string): ContentLine | null {
  // The value starts after the first colon that is not inside a quoted
  // parameter — `ATTENDEE;CN="Smith, J:r":mailto:j@x` is legal and rare enough
  // that a naive split on the first colon truncates it silently.
  let inQuotes = false;
  let colon = -1;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') inQuotes = !inQuotes;
    else if (character === ':' && !inQuotes) {
      colon = index;
      break;
    }
  }

  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = unescapeValue(line.slice(colon + 1));

  const [name, ...rest] = head.split(';');
  const params: Record<string, string> = {};

  for (const parameter of rest) {
    const equals = parameter.indexOf('=');
    if (equals === -1) continue;
    params[parameter.slice(0, equals).toUpperCase()] = parameter
      .slice(equals + 1)
      .replace(/^"|"$/g, '');
  }

  return { name: (name ?? '').toUpperCase(), params, value };
}

function unescapeValue(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export interface CalendarEvent {
  readonly uid: string | null;
  readonly summary: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly all_day: boolean;
  readonly location: string | null;
  readonly description: string | null;
  readonly organizer: string | null;
  readonly attendees: readonly string[];
  readonly status: string | null;
  /** Present only when the server declined to expand a repeating event. */
  readonly recurrence_rule?: string;
}

/** The VEVENTs in one iCalendar document. */
export function parseEvents(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: ContentLine[] | null = null;

  for (const line of parseLines(text)) {
    if (line.name === 'BEGIN' && line.value === 'VEVENT') {
      current = [];
      continue;
    }
    if (line.name === 'END' && line.value === 'VEVENT') {
      if (current) events.push(toEvent(current));
      current = null;
      continue;
    }
    current?.push(line);
  }

  return events;
}

function toEvent(lines: readonly ContentLine[]): CalendarEvent {
  const first = (name: string): ContentLine | undefined => lines.find((l) => l.name === name);
  const start = first('DTSTART');
  const rrule = first('RRULE');

  return {
    uid: first('UID')?.value ?? null,
    summary: first('SUMMARY')?.value ?? null,
    start: start ? normaliseDate(start) : null,
    end: (() => {
      const end = first('DTEND');
      return end ? normaliseDate(end) : null;
    })(),
    // `VALUE=DATE` is the marker for an all-day event; the absence of a time is
    // not incidental formatting.
    all_day: start?.params['VALUE'] === 'DATE',
    location: first('LOCATION')?.value ?? null,
    description: first('DESCRIPTION')?.value ?? null,
    organizer: first('ORGANIZER')?.value.replace(/^mailto:/i, '') ?? null,
    attendees: lines
      .filter((line) => line.name === 'ATTENDEE')
      .map((line) => line.value.replace(/^mailto:/i, '')),
    status: first('STATUS')?.value ?? null,
    ...(rrule ? { recurrence_rule: rrule.value } : {}),
  };
}

/**
 * The three forms a DTSTART takes, as ISO 8601.
 *
 * `VALUE=DATE:20260810`, `TZID=Europe/London:20260810T090000`, and
 * `20260810T080000Z`. The middle one keeps its zone as a suffix rather than
 * being converted: converting needs a tz database, and guessing is worse than
 * saying which zone the server meant.
 */
export function normaliseDate(line: ContentLine): string {
  const value = line.value.trim();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return value;

  const [, year, month, day, hour, minute, second, zulu] = match;
  if (!hour) return `${year}-${month}-${day}`;

  const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (zulu) return `${stamp}Z`;

  const zone = line.params['TZID'];
  return zone ? `${stamp} (${zone})` : stamp;
}

/** ISO 8601 in, iCalendar's compact form out. */
function toIcalDate(value: string, allDay: boolean): string {
  const digits = value.replace(/[-:]/g, '');
  if (allDay) return digits.slice(0, 8);
  if (digits.endsWith('Z')) return digits.replace(/\.\d+Z$/, 'Z').slice(0, 16) + 'Z';
  return `${digits.slice(0, 15)}`;
}

export interface NewEvent {
  readonly uid: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay?: boolean | undefined;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly timestamp: string;
}

/** Build a minimal, valid VCALENDAR carrying one VEVENT. */
export function buildEvent(event: NewEvent): string {
  const allDay = event.allDay === true;
  const dateParam = allDay ? ';VALUE=DATE' : '';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lanes Link//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${toIcalDate(event.timestamp, false)}`,
    `DTSTART${dateParam}:${toIcalDate(event.start, allDay)}`,
    `DTEND${dateParam}:${toIcalDate(event.end, allDay)}`,
    `SUMMARY:${escapeValue(event.summary)}`,
    ...(event.location ? [`LOCATION:${escapeValue(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeValue(event.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  // CRLF, which RFC 5545 requires and some servers enforce.
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Fold at 75 octets, as the spec requires for long values. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  parts.push(` ${rest}`);
  return parts.join('\r\n');
}

export interface EventPatch {
  readonly summary?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly allDay?: boolean | undefined;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly timestamp: string;
}

/**
 * Edit an existing VEVENT in place, by patching its text.
 *
 * Rebuilding the event from the fields we model would silently discard
 * everything we do not — attendees and their reply status, alarms, the RRULE, a
 * conferencing URL, `X-` properties another client depends on. Changing the time
 * of a meeting must not un-invite everyone, so the untouched lines are carried
 * through verbatim and only the named properties are replaced.
 *
 * `SEQUENCE` is bumped and `DTSTAMP` refreshed because that is how every other
 * calendar client learns something changed; without it the edit lands on the
 * server and no device notices.
 */
export function patchEvent(ical: string, patch: EventPatch): string {
  const lines = ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

  const start = lines.findIndex((line) => line.trim() === 'BEGIN:VEVENT');
  const end = lines.findIndex((line) => line.trim() === 'END:VEVENT');
  if (start === -1 || end === -1) throw new Error('That entry does not contain an event to edit.');

  const nameOf = (line: string): string => (line.split(/[;:]/)[0] ?? '').toUpperCase();
  const body = lines.slice(start + 1, end);

  const allDay =
    patch.allDay ?? body.some((line) => nameOf(line) === 'DTSTART' && /VALUE=DATE[:;]/.test(line));
  const dateParam = allDay ? ';VALUE=DATE' : '';

  const replacements = new Map<string, string | null>();
  if (patch.summary !== undefined) replacements.set('SUMMARY', `SUMMARY:${escapeValue(patch.summary)}`);
  if (patch.location !== undefined) {
    replacements.set('LOCATION', patch.location ? `LOCATION:${escapeValue(patch.location)}` : null);
  }
  if (patch.description !== undefined) {
    replacements.set(
      'DESCRIPTION',
      patch.description ? `DESCRIPTION:${escapeValue(patch.description)}` : null,
    );
  }
  // Replacing the whole line drops a stale `TZID` along with it, which matters:
  // keeping the old zone against a new UTC time silently moves the meeting.
  if (patch.start !== undefined) {
    replacements.set('DTSTART', `DTSTART${dateParam}:${toIcalDate(patch.start, allDay)}`);
  }
  if (patch.end !== undefined) {
    replacements.set('DTEND', `DTEND${dateParam}:${toIcalDate(patch.end, allDay)}`);
  }

  replacements.set('DTSTAMP', `DTSTAMP:${toIcalDate(patch.timestamp, false)}`);

  const current = body.find((line) => nameOf(line) === 'SEQUENCE');
  const sequence = current ? Number(current.split(':')[1] ?? 0) || 0 : 0;
  replacements.set('SEQUENCE', `SEQUENCE:${sequence + 1}`);

  const seen = new Set<string>();
  const patched: string[] = [];

  for (const line of body) {
    const name = nameOf(line);
    if (!replacements.has(name)) {
      patched.push(line);
      continue;
    }
    seen.add(name);
    const replacement = replacements.get(name);
    if (replacement !== null && replacement !== undefined) patched.push(replacement);
  }

  // A property being set for the first time has nothing to replace.
  for (const [name, replacement] of replacements) {
    if (!seen.has(name) && replacement) patched.push(replacement);
  }

  const rebuilt = [...lines.slice(0, start + 1), ...patched, ...lines.slice(end)];
  return `${rebuilt.filter((line) => line !== '').map(fold).join('\r\n')}\r\n`;
}

export interface NewContact {
  readonly uid: string;
  readonly fullName: string;
  readonly emails?: readonly string[] | undefined;
  readonly phones?: readonly string[] | undefined;
  readonly organization?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * Build a vCard 3.0.
 *
 * 3.0 rather than 4.0 because it is what Apple writes and what every client
 * reads; 4.0 support is uneven enough that the safe choice is the older one.
 */
export function buildContact(contact: NewContact): string {
  // `N` is structured as family;given;middle;prefix;suffix. Splitting a display
  // name on the last space is a guess, but an absent `N` breaks sorting in
  // Contacts, and a wrong guess is visible and fixable where a missing field is
  // neither.
  const parts = contact.fullName.trim().split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1]! : '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : contact.fullName;

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${contact.uid}`,
    `FN:${escapeValue(contact.fullName)}`,
    `N:${escapeValue(family)};${escapeValue(given)};;;`,
    ...(contact.emails ?? []).map((email) => `EMAIL;TYPE=INTERNET:${escapeValue(email)}`),
    ...(contact.phones ?? []).map((phone) => `TEL;TYPE=CELL:${escapeValue(phone)}`),
    ...(contact.organization ? [`ORG:${escapeValue(contact.organization)}`] : []),
    ...(contact.note ? [`NOTE:${escapeValue(contact.note)}`] : []),
    'END:VCARD',
  ];

  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export interface Contact {
  readonly uid: string | null;
  readonly full_name: string | null;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly organization: string | null;
  readonly note: string | null;
}

/** The VCARDs in one document. vCard 3.0 and 4.0 share this grammar. */
export function parseContacts(text: string): Contact[] {
  const contacts: Contact[] = [];
  let current: ContentLine[] | null = null;

  for (const line of parseLines(text)) {
    if (line.name === 'BEGIN' && line.value === 'VCARD') {
      current = [];
      continue;
    }
    if (line.name === 'END' && line.value === 'VCARD') {
      if (current) contacts.push(toContact(current));
      current = null;
      continue;
    }
    current?.push(line);
  }

  return contacts;
}

function toContact(lines: readonly ContentLine[]): Contact {
  const first = (name: string): string | null =>
    lines.find((line) => line.name === name)?.value ?? null;

  return {
    uid: first('UID'),
    // FN is the display name; N is the structured one and is not always present.
    full_name: first('FN') ?? first('N')?.split(';').filter(Boolean).reverse().join(' ') ?? null,
    emails: lines.filter((line) => line.name === 'EMAIL').map((line) => line.value),
    phones: lines.filter((line) => line.name === 'TEL').map((line) => line.value),
    organization: first('ORG')?.split(';')[0] ?? null,
    note: first('NOTE'),
  };
}

export /** iCalendar's compact UTC stamp, which time-range filters require. */
function compact(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}
