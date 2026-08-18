import { parseXml, XmlElement, type XmlNode } from '@rgrove/parse-xml';

/**
 * Reading WebDAV's `multistatus` replies.
 *
 * Namespaces are resolved to `{uri}local` rather than matched by prefix,
 * because the prefix is the server's choice and servers disagree freely:
 * iCloud writes `<D:href>`, Fastmail `<d:href>`, Nextcloud `<href>` with a
 * default namespace. Anything matching on `D:` works against one vendor and
 * silently finds nothing against the next — and "found nothing" is
 * indistinguishable from "you have no calendars".
 *
 * Building the request side is templates plus escaping, not a serialiser: there
 * are four bodies, each fixed apart from a date range or a search string.
 */

/** DAV namespace URIs, as constants because they are typed wrong so easily. */
export const DAV = 'DAV:';
export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const CARDDAV = 'urn:ietf:params:xml:ns:carddav';

export interface DavNode {
  /** `{DAV:}href` — namespace URI in braces, then the local name. */
  readonly qname: string;
  readonly text: string;
  /**
   * Kept because DAV puts real answers in attributes, not only in text:
   * `<C:comp name="VEVENT"/>` is how a collection says whether it holds events
   * or reminders, and that distinction decides whether it is a calendar at all.
   */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly DavNode[];
}

/**
 * Parse a DAV response body.
 *
 * A `<!DOCTYPE` is refused outright rather than parsed. That is the entire
 * defence against both XXE and the billion-laughs expansion, it costs one line,
 * and no DAV server has any reason to send one.
 */
export function parseDav(xml: string): DavNode {
  if (/<!DOCTYPE/i.test(xml)) {
    throw new Error('The server sent XML with a DOCTYPE, which this client refuses to parse.');
  }

  const document = parseXml(xml, { ignoreUndefinedEntities: true });
  const root = document.children.find((node): node is XmlElement => node instanceof XmlElement);
  if (!root) throw new Error('The server sent XML with no root element.');

  return normalise(root, new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]));
}

function normalise(element: XmlElement, inherited: ReadonlyMap<string, string>): DavNode {
  const prefixes = new Map(inherited);

  for (const [name, value] of Object.entries(element.attributes)) {
    if (name === 'xmlns') prefixes.set('', value);
    else if (name.startsWith('xmlns:')) prefixes.set(name.slice(6), value);
  }

  const colon = element.name.indexOf(':');
  const prefix = colon === -1 ? '' : element.name.slice(0, colon);
  const local = colon === -1 ? element.name : element.name.slice(colon + 1);
  const uri = prefixes.get(prefix) ?? '';

  return {
    qname: `{${uri}}${local}`,
    text: element.text,
    attributes: element.attributes,
    children: element.children
      .filter((child: XmlNode): child is XmlElement => child instanceof XmlElement)
      .map((child) => normalise(child, prefixes)),
  };
}

/** Every descendant with this qualified name, at any depth. */
export function findAll(node: DavNode, qname: string): DavNode[] {
  const found: DavNode[] = [];
  const walk = (current: DavNode): void => {
    if (current.qname === qname) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

/** The first descendant with this qualified name. */
export function find(node: DavNode, qname: string): DavNode | undefined {
  return findAll(node, qname)[0];
}

/** The text of the first descendant with this qualified name. */
export function textOf(node: DavNode, qname: string): string | undefined {
  const found = find(node, qname);
  const text = found?.text.trim();
  return text ? text : undefined;
}

/**
 * Whether a `propstat` block actually succeeded.
 *
 * A multistatus reports per-property status, so a `<prop>` present in the reply
 * is not a property the server *has* — a 404 propstat carries the same element
 * names, empty. Reading those as values is how a calendar list comes back full
 * of blanks.
 */
export function successful(response: DavNode): DavNode[] {
  return findAll(response, `{${DAV}}propstat`).filter((propstat) => {
    const status = textOf(propstat, `{${DAV}}status`) ?? '';
    return / 2\d\d /.test(status) || status.includes('200');
  });
}

/** Escape text destined for an XML body. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
