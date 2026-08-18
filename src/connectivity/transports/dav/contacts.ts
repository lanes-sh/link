import type { ToolResult } from '#connectivity';
import { buildContact, parseContacts } from './ical.ts';
import { error, json } from './request.ts';
import { CARDDAV, DAV, escapeXml, findAll, parseDav, textOf } from './xml.ts';
import type { DavClient } from './client.ts';

/** CardDAV's two operations. Same shape as `calendar.ts`, and same reason. */

export async function createContact(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const books = await dav.collections();
    const wanted = args['addressbook'] ? String(args['addressbook']) : undefined;
    const book = wanted ? books.find((entry) => entry.name === wanted) : books[0];
    if (!book) return error(wanted ? `No address book named "${wanted}".` : 'No address books.');

    const uid = crypto.randomUUID();
    const vcard = buildContact({
      uid,
      fullName: String(args['full_name'] ?? ''),
      emails: args['emails'] as string[] | undefined,
      phones: args['phones'] as string[] | undefined,
      organization: args['organization'] as string | undefined,
      note: args['note'] as string | undefined,
    });

    const href = new URL(`${uid}.vcf`, `${book.href.replace(/\/?$/, '/')}`).href;
    const reply = await dav.request(href, 'PUT', vcard, {
      'content-type': 'text/vcard; charset=utf-8',
      'if-none-match': '*',
    });

    if (reply.status >= 400) {
      return error(`The server refused the contact (${reply.status}). ${reply.text.slice(0, 200)}`);
    }

    return json({ created: true, uid, addressbook: book.name });
  }

export async function searchContacts(
  dav: DavClient,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
    const query = String(args['query'] ?? '');
    if (!query) return error('query is required.');
    const limit = Math.min(Number(args['limit'] ?? 25) || 25, 100);

    const escaped = escapeXml(query);
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<c:addressbook-query xmlns:d="DAV:" xmlns:c="${CARDDAV}">` +
      `<d:prop><d:getetag/><c:address-data/></d:prop>` +
      `<c:filter test="anyof">` +
      `<c:prop-filter name="FN"><c:text-match collation="i;unicode-casemap" match-type="contains">${escaped}</c:text-match></c:prop-filter>` +
      `<c:prop-filter name="EMAIL"><c:text-match collation="i;unicode-casemap" match-type="contains">${escaped}</c:text-match></c:prop-filter>` +
      `</c:filter></c:addressbook-query>`;

    const contacts: unknown[] = [];

    for (const collection of await dav.collections()) {
      const result = await dav.request(collection.href, 'REPORT', body, { depth: '1' });
      if (result.status >= 400) continue;

      for (const response of findAll(parseDav(result.text), `{${DAV}}response`)) {
        const data = textOf(response, `{${CARDDAV}}address-data`);
        if (!data) continue;
        for (const contact of parseContacts(data)) {
          contacts.push({ ...contact, addressbook: collection.name });
        }
      }
    }

    return json({ query, contacts: contacts.slice(0, limit) });
  }
