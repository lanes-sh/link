import { describe, expect, test } from 'bun:test';
import { DAV, CALDAV, escapeXml, findAll, parseDav, successful, textOf } from './xml.ts';

/**
 * Namespace handling, which is the whole reason this file exists.
 *
 * The prefix is the server's choice and servers disagree: iCloud writes
 * `<D:href>`, Fastmail `<d:href>`, Nextcloud a default namespace with no prefix
 * at all. Matching on the prefix works against one vendor and silently finds
 * nothing against the next — and finding nothing is indistinguishable from
 * having no calendars.
 */

const withPrefix = (prefix: string) => `<?xml version="1.0"?>
<${prefix}multistatus xmlns${prefix ? `:${prefix.slice(0, -1)}` : ''}="DAV:">
  <${prefix}response>
    <${prefix}href>/1234/calendars/home/</${prefix}href>
    <${prefix}propstat>
      <${prefix}status>HTTP/1.1 200 OK</${prefix}status>
      <${prefix}prop><${prefix}displayname>Home</${prefix}displayname></${prefix}prop>
    </${prefix}propstat>
  </${prefix}response>
</${prefix}multistatus>`;

describe('prefixes are resolved, not matched', () => {
  test.each([['D:'], ['d:'], ['']])('a %s prefix finds the same nodes', (prefix) => {
    const tree = parseDav(withPrefix(prefix));

    expect(findAll(tree, `{${DAV}}response`)).toHaveLength(1);
    expect(textOf(tree, `{${DAV}}href`)).toBe('/1234/calendars/home/');
    expect(textOf(tree, `{${DAV}}displayname`)).toBe('Home');
  });

  test('a prefix bound to a different namespace does not collide', () => {
    // `c:` meaning CalDAV in one document and something else in another is
    // legal; resolving to the URI is what keeps them apart.
    const xml = `<?xml version="1.0"?>
      <multistatus xmlns="DAV:" xmlns:c="${CALDAV}">
        <response><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data></response>
      </multistatus>`;

    const tree = parseDav(xml);

    expect(textOf(tree, `{${CALDAV}}calendar-data`)).toBe('BEGIN:VCALENDAR');
    expect(textOf(tree, `{${DAV}}calendar-data`)).toBeUndefined();
  });
});

describe('what a multistatus actually claims', () => {
  test('a 404 propstat is not a value', () => {
    // A multistatus reports status per property, so a `<prop>` in the reply is
    // not a property the server has — a 404 block carries the same element
    // names, empty. Reading those is how a calendar list comes back full of
    // blanks.
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/x/</d:href>
          <d:propstat>
            <d:prop><d:displayname>Real</d:displayname></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat>
          <d:propstat>
            <d:prop><d:getctag/></d:prop>
            <d:status>HTTP/1.1 404 Not Found</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>`;

    const response = findAll(parseDav(xml), `{${DAV}}response`)[0]!;
    const good = successful(response);

    expect(good).toHaveLength(1);
    expect(textOf(good[0]!, `{${DAV}}displayname`)).toBe('Real');
  });
});

describe('hostile input', () => {
  test('a DOCTYPE is refused rather than parsed', () => {
    // One line, and it is the entire defence against both XXE and the
    // billion-laughs expansion. No DAV server has a reason to send one.
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <d:multistatus xmlns:d="DAV:"><d:href>&xxe;</d:href></d:multistatus>`;

    expect(() => parseDav(xml)).toThrow(/DOCTYPE/);
  });

  test('malformed XML throws rather than returning a half tree', () => {
    expect(() => parseDav('<d:multistatus xmlns:d="DAV:"><d:href></d:multistatus>')).toThrow();
  });
});

describe('escaping', () => {
  test('a search term cannot close the element it sits in', () => {
    expect(escapeXml('</text-match><evil/>')).toBe('&lt;/text-match&gt;&lt;evil/&gt;');
  });

  test('ampersands and quotes are escaped', () => {
    expect(escapeXml(`Tom & "Jerry"`)).toBe('Tom &amp; &quot;Jerry&quot;');
  });
});
