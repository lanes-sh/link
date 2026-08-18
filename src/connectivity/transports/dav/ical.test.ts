import { describe, expect, test } from 'bun:test';
import {
  buildContact,
  buildEvent,
  normaliseDate,
  parseContacts,
  parseEvents,
  parseLines,
  patchEvent,
} from './ical.ts';

describe('content lines', () => {
  test('folded lines are rejoined before anything else happens', () => {
    // A long SUMMARY is routinely folded mid-word at 75 octets. Parsing before
    // unfolding turns one property into two, the second unrecognisable.
    const text = 'SUMMARY:Quarterly planning with the whole\r\n  team and guests\r\n';

    expect(parseLines(text)[0]).toMatchObject({
      name: 'SUMMARY',
      value: 'Quarterly planning with the whole team and guests',
    });
  });

  test('escaped commas and semicolons survive', () => {
    const [line] = parseLines('DESCRIPTION:Bring\\, if you can\\; a laptop\\nand a pen\r\n');

    expect(line?.value).toBe('Bring, if you can; a laptop\nand a pen');
  });

  test('a colon inside a quoted parameter does not split the line early', () => {
    // `CN="Smith, J:r"` is legal, and splitting on the first colon truncates it.
    const [line] = parseLines('ATTENDEE;CN="Smith, J:r":mailto:j@example.com\r\n');

    expect(line?.name).toBe('ATTENDEE');
    expect(line?.value).toBe('mailto:j@example.com');
    expect(line?.params['CN']).toBe('Smith, J:r');
  });
});

describe('dates', () => {
  test('the three forms a DTSTART takes', () => {
    expect(normaliseDate({ name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20260810' })).toBe(
      '2026-08-10',
    );
    expect(normaliseDate({ name: 'DTSTART', params: {}, value: '20260810T080000Z' })).toBe(
      '2026-08-10T08:00:00Z',
    );
    // The zone is kept as a suffix rather than converted: converting needs a tz
    // database, and guessing is worse than saying which zone the server meant.
    expect(
      normaliseDate({ name: 'DTSTART', params: { TZID: 'Europe/London' }, value: '20260810T090000' }),
    ).toBe('2026-08-10T09:00:00 (Europe/London)');
  });
});

const EVENT = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc-123
SUMMARY:Standup
DTSTART;TZID=Europe/Amsterdam:20260810T090000
DTEND;TZID=Europe/Amsterdam:20260810T091500
LOCATION:Room 3
ORGANIZER:mailto:ada@example.com
ATTENDEE:mailto:sam@example.com
ATTENDEE:mailto:kim@example.com
END:VEVENT
END:VCALENDAR`;

describe('events', () => {
  test('the fields anyone actually wants', () => {
    const [event] = parseEvents(EVENT);

    expect(event).toMatchObject({
      uid: 'abc-123',
      summary: 'Standup',
      start: '2026-08-10T09:00:00 (Europe/Amsterdam)',
      location: 'Room 3',
      organizer: 'ada@example.com',
      attendees: ['sam@example.com', 'kim@example.com'],
      all_day: false,
    });
  });

  test('an all-day event is marked, not silently given a midnight time', () => {
    const text = 'BEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20260810\r\nEND:VEVENT';

    expect(parseEvents(text)[0]).toMatchObject({ all_day: true, start: '2026-08-10' });
  });

  test('a surviving RRULE is reported rather than hidden', () => {
    // It means the server ignored `<C:expand>`, so the caller must say the
    // instances were not expanded instead of presenting a master as one.
    const text = 'BEGIN:VEVENT\r\nUID:x\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT';

    expect(parseEvents(text)[0]?.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  test('several events in one document are all found', () => {
    expect(parseEvents(`${EVENT}\n${EVENT}`)).toHaveLength(2);
  });
});

describe('building an event', () => {
  const built = buildEvent({
    uid: 'new-1@lanes-link',
    summary: 'Coffee; with Sam, maybe',
    start: '2026-08-11T10:00:00Z',
    end: '2026-08-11T10:30:00Z',
    timestamp: '2026-08-10T12:00:00Z',
  });

  test('it round-trips through the parser', () => {
    const [event] = parseEvents(built);

    expect(event).toMatchObject({ uid: 'new-1@lanes-link', summary: 'Coffee; with Sam, maybe' });
  });

  test('separators in a summary are escaped, not left to split the line', () => {
    expect(built).toContain('SUMMARY:Coffee\\; with Sam\\, maybe');
  });

  test('lines end in CRLF, which RFC 5545 requires', () => {
    expect(built.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
  });

  test('an all-day event uses VALUE=DATE and no time', () => {
    const allDay = buildEvent({
      uid: 'x',
      summary: 'Holiday',
      start: '2026-08-11',
      end: '2026-08-12',
      allDay: true,
      timestamp: '2026-08-10T12:00:00Z',
    });

    expect(allDay).toContain('DTSTART;VALUE=DATE:20260811');
    expect(allDay).not.toContain('DTSTART;VALUE=DATE:20260811T');
  });
});

describe('contacts', () => {
  test('vCard 3.0, as iCloud writes it', () => {
    const card = `BEGIN:VCARD
VERSION:3.0
UID:c-1
FN:Sam Jones
ORG:Acme Ltd;Engineering
EMAIL;TYPE=INTERNET:sam@example.com
EMAIL;TYPE=WORK:s.jones@acme.test
TEL;TYPE=CELL:+31 6 1234 5678
NOTE:Met at the conference
END:VCARD`;

    expect(parseContacts(card)[0]).toEqual({
      uid: 'c-1',
      full_name: 'Sam Jones',
      emails: ['sam@example.com', 's.jones@acme.test'],
      phones: ['+31 6 1234 5678'],
      organization: 'Acme Ltd',
      note: 'Met at the conference',
    });
  });

  test('a card with no FN falls back to the structured name', () => {
    const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Jones;Sam;;;\r\nEND:VCARD';

    expect(parseContacts(card)[0]?.full_name).toBe('Sam Jones');
  });
});

describe('patching an event', () => {
  const ORIGINAL = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:abc-123',
    'SUMMARY:Standup',
    'DTSTART;TZID=Europe/Amsterdam:20260810T090000',
    'DTEND;TZID=Europe/Amsterdam:20260810T091500',
    'LOCATION:Room 3',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:sam@example.com',
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'END:VALARM',
    'SEQUENCE:2',
    'X-APPLE-TRAVEL-DURATION:PT15M',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const patch = (changes: Record<string, unknown>) =>
    patchEvent(ORIGINAL, { timestamp: '2026-08-10T12:00:00Z', ...changes });

  test('everything unmentioned survives verbatim', () => {
    // Rebuilding from the fields we model would un-invite the attendee, drop the
    // alarm, and turn a weekly meeting into a one-off. Changing the time of a
    // meeting must not do any of that.
    const result = patch({ summary: 'Standup (moved)' });

    expect(result).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:sam@example.com');
    expect(result).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(result).toContain('TRIGGER:-PT10M');
    expect(result).toContain('X-APPLE-TRAVEL-DURATION:PT15M');
    expect(result).toContain('UID:abc-123');
  });

  test('SEQUENCE is bumped, or no other client notices the edit', () => {
    expect(patch({ summary: 'x' })).toContain('SEQUENCE:3');
  });

  test('DTSTAMP is refreshed', () => {
    expect(patch({ summary: 'x' })).toContain('DTSTAMP:20260810T120000Z');
  });

  test('a new time drops the old TZID rather than keeping it', () => {
    // Keeping `TZID=Europe/Amsterdam` against a new UTC time silently moves the
    // meeting by the offset.
    const result = patch({ start: '2026-08-10T10:00:00Z' });

    expect(result).toContain('DTSTART:20260810T100000Z');
    expect(result).not.toContain('DTSTART;TZID=Europe/Amsterdam');
  });

  test('an empty string clears a field rather than setting it empty', () => {
    expect(patch({ location: '' })).not.toContain('LOCATION');
  });

  test('a field absent from the original is added', () => {
    expect(patch({ description: 'Agenda attached' })).toContain('DESCRIPTION:Agenda attached');
  });

  test('the result still parses, and reflects the change', () => {
    const [event] = parseEvents(patch({ summary: 'Renamed', location: 'Room 5' }));

    expect(event).toMatchObject({ uid: 'abc-123', summary: 'Renamed', location: 'Room 5' });
    expect(event?.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  test('an entry with no event is refused rather than silently mangled', () => {
    expect(() =>
      patchEvent('BEGIN:VCALENDAR\r\nEND:VCALENDAR', { timestamp: '2026-08-10T12:00:00Z' }),
    ).toThrow(/does not contain an event/);
  });
});

describe('building a contact', () => {
  test('round-trips, and splits the name for sorting', () => {
    const card = buildContact({
      uid: 'c-9',
      fullName: 'Sam Jones',
      emails: ['sam@example.com'],
      phones: ['+31 6 1234 5678'],
      organization: 'Acme',
    });

    expect(card).toContain('N:Jones;Sam;;;');
    expect(parseContacts(card)[0]).toMatchObject({
      uid: 'c-9',
      full_name: 'Sam Jones',
      emails: ['sam@example.com'],
      organization: 'Acme',
    });
  });

  test('a single-word name is left as the given name', () => {
    expect(buildContact({ uid: 'c-1', fullName: 'Cher' })).toContain('N:;Cher;;;');
  });
});
