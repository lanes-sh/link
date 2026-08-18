import type { ToolResult } from '#connectivity';
import { DAV, find, findAll, parseDav, successful, textOf, type DavNode } from './xml.ts';
import type { DavConnectorOptions } from './index.ts';

/**
 * The HTTP half of DAV: one request helper, the redirect rule, and the
 * connect-time credential check.
 *
 * Everything here is protocol plumbing that knows nothing about calendars or
 * contacts, which is why it is separate from both.
 */

/**
 * Check the credential against the server, returning the username it accepted.
 *
 * This is the one place the connector builds an Authorization header itself,
 * because there is no `ConnectorContext` at connect time to do it — the
 * connection does not exist in config yet. It never reads the credential
 * *store*: what it gets is already resolved and bound to one account.
 */
export async function validate(
  options: DavConnectorOptions,
  doFetch: typeof globalThis.fetch,
): Promise<string | null> {
  if (!options.credential) return null;

  const { username, password } = await options.credential();
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const wellKnown = new URL(
    options.service === 'caldav' ? '/.well-known/caldav' : '/.well-known/carddav',
    options.baseUrl,
  ).href;

  const reply = await davRequest(
    doFetch,
    async (request) => {
      const authorised = new Request(request, { headers: new Headers(request.headers) });
      authorised.headers.set('authorization', `Basic ${encoded}`);
      return authorised;
    },
    wellKnown,
    'PROPFIND',
    PRINCIPAL_BODY,
    { depth: '0' },
  );

  if (reply.status === 401 || reply.status === 403) {
    throw new Error(
      `The server rejected the credential for ${username}.` +
        (options.troubleshooting ? `\n  ${options.troubleshooting}` : ''),
    );
  }
  if (reply.status >= 400) {
    throw new Error(`The server refused discovery (${reply.status}).`);
  }

  return username;
}

/**
 * The `href` inside a named property, from a propstat that actually succeeded.
 *
 * A multistatus reports status *per property*, so the presence of an element is
 * not the presence of a value: iCloud answers `<current-user-principal/>`, empty,
 * under a 404 propstat. Reading that as an answer is how discovery silently
 * concludes you have no principal.
 */
export function hrefOfProperty(tree: DavNode, qname: string): string | undefined {
  for (const response of findAll(tree, `{${DAV}}response`)) {
    for (const propstat of successful(response)) {
      const property = find(propstat, qname);
      const href = property ? textOf(property, `{${DAV}}href`) : undefined;
      if (href) return href;
    }
  }
  return undefined;
}

export function error(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

interface Collection {
  readonly name: string;
  readonly href: string;
}

export interface DavReply {
  readonly status: number;
  readonly text: string;
  readonly url: string;
}

export const PRINCIPAL_BODY =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

/**
 * A DAV request, with the redirect policy this protocol needs.
 *
 * Redirects are followed by hand. `fetch`'s automatic handling would resend the
 * Authorization header to wherever it was pointed — an app-specific password
 * handed to whoever the Location names — and it does not reliably repeat a body
 * for a non-standard method, which every request here has.
 */
export async function davRequest(
  doFetch: typeof globalThis.fetch,
  authorize: (request: Request) => Promise<Request>,
  url: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<DavReply> {
  let target = url;

  for (let hop = 0; hop < 5; hop++) {
    const request = await authorize(
      new Request(target, {
        method,
        headers: { 'content-type': 'application/xml; charset=utf-8', ...headers },
        ...(body ? { body } : {}),
        redirect: 'manual',
      }),
    );

    const response = await doFetch(request);

    if (![301, 302, 307, 308].includes(response.status)) {
      return { status: response.status, text: await response.text(), url: target };
    }

    const location = response.headers.get('location');
    if (!location) break;

    const next = new URL(location, target);
    // iCloud relocates to a numbered partition of its own domain. Following
    // *off* the registrable domain would hand the credential to a stranger.
    if (next.protocol !== 'https:' || !sameSite(next.hostname, new URL(target).hostname)) {
      throw new Error(
        `The server redirected to ${next.origin}, which is not the host you configured. Refusing to send credentials there.`,
      );
    }

    target = next.href;
  }

  throw new Error('Too many redirects while talking to the DAV server.');
}



/** Whether a redirect stayed within the same registrable domain. */
export function sameSite(next: string, current: string): boolean {
  if (next === current) return true;
  const tail = current.split('.').slice(-2).join('.');
  return next === tail || next.endsWith(`.${tail}`);
}
