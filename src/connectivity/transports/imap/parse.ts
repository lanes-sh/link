import { quoted } from './client.ts';
import { asText, itemValue, type ImapToken } from './parser.ts';
import { SETTABLE_FLAGS } from './operations.ts';

/**
 * Turning IMAP's wire vocabulary into ordinary values.
 *
 * Dates in its own peculiar `DD-Mon-YYYY`, SEARCH criteria, flag lists, and the
 * ENVELOPE structure — none of which any other transport has an opinion about.
 */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP wants `1-Aug-2026`, and rejects anything else without explaining. */
export function imapDate(value: string): string | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  return `${Number(match[3])}-${MONTHS[Number(match[2]) - 1]}-${match[1]}`;
}

export function searchCriteria(args: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];

  const term = (key: string, keyword: string): void => {
    const value = args[key];
    if (typeof value === 'string' && value) parts.push(`${keyword} ${quoted(value)}`);
  };

  term('from', 'FROM');
  term('to', 'TO');
  term('subject', 'SUBJECT');
  term('text', 'TEXT');

  for (const [key, keyword] of [
    ['since', 'SINCE'],
    ['before', 'BEFORE'],
  ] as const) {
    const value = args[key];
    if (typeof value === 'string') {
      const formatted = imapDate(value);
      if (formatted) parts.push(`${keyword} ${formatted}`);
    }
  }

  if (args['unseen'] === true) parts.push('UNSEEN');
  if (args['flagged'] === true) parts.push('FLAGGED');

  return parts.length > 0 ? parts.join(' ') : 'ALL';
}

export function uidList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => Number(entry)).filter((uid) => Number.isFinite(uid) && uid > 0);
}

/**
 * Only flags on the allowlist, silently dropping the rest.
 *
 * `\Deleted` is the one that matters: accepting it would let an agent stage a
 * mailbox for destruction through a capability whose name says "mark".
 */
export function allowedFlags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(SETTABLE_FLAGS);
  return value.map(String).filter((flag) => allowed.has(flag));
}

export function flagList(token: ImapToken | undefined): string[] {
  if (!token || token.kind !== 'list') return [];
  return token.items.map((item) => asText(item)).filter((flag): flag is string => Boolean(flag));
}

/**
 * The parts of an ENVELOPE worth showing.
 *
 * Positional, per RFC 3501: date, subject, from, sender, reply-to, to, cc, bcc,
 * in-reply-to, message-id. Addresses are `(name adl mailbox host)`.
 */
export function envelopeSummary(token: ImapToken | undefined): Record<string, unknown> {
  if (!token || token.kind !== 'list') return {};
  const fields = token.items;

  return {
    subject: asText(fields[1]) ?? null,
    from: addressList(fields[2])[0] ?? null,
    to: addressList(fields[5]),
    message_id: asText(fields[9]) ?? null,
  };
}

export function addressList(token: ImapToken | undefined): string[] {
  if (!token || token.kind !== 'list') return [];

  return token.items
    .map((entry) => {
      if (entry.kind !== 'list') return null;
      const name = asText(entry.items[0]);
      const local = asText(entry.items[2]);
      const host = asText(entry.items[3]);
      if (!local || !host) return null;
      const address = `${local}@${host}`;
      return name ? `${name} <${address}>` : address;
    })
    .filter((entry): entry is string => entry !== null);
}

export function formatAddress(address: {
  name?: string | undefined;
  address?: string | undefined;
}): string {
  // A group address (`undisclosed-recipients:;`) has a name and no address.
  if (!address.address) return address.name ?? '';
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/** A readable fallback when a message carries only HTML. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
