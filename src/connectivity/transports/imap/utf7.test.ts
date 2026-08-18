import { describe, expect, test } from 'bun:test';
import { decodeMailboxName, encodeMailboxName } from './utf7.ts';

/**
 * The vectors here are RFC 3501 §5.1.3's own, plus the cases a real mailbox
 * list turns up. Worth pinning both directions: decoding wrong shows an agent a
 * folder nobody recognises, while encoding wrong sends `SELECT` for a mailbox
 * the server does not have — and a failed SELECT reads exactly like an empty
 * folder.
 */

const VECTORS: readonly [decoded: string, encoded: string][] = [
  ['INBOX', 'INBOX'],
  ['Sent Messages', 'Sent Messages'],
  // The RFC's own example.
  ['~peter/mail/台北/日本語', '~peter/mail/&U,BTFw-/&ZeVnLIqe-'],
  // `&` is the escape character, so it has to escape itself.
  ['R&D', 'R&-D'],
  ['&', '&-'],
  ['Wichtig ✓', 'Wichtig &JxM-'],
  // `,` stands in for base64's `/` precisely so the hierarchy delimiter is free.
  ['Archive/2026', 'Archive/2026'],
];

describe('modified UTF-7 round-trips', () => {
  test.each(VECTORS)('%s', (decoded, encoded) => {
    expect(decodeMailboxName(encoded)).toBe(decoded);
    expect(encodeMailboxName(decoded)).toBe(encoded);
  });
});

describe('edge cases a real server produces', () => {
  test('a name that is entirely encoded', () => {
    expect(decodeMailboxName('&ZeVnLIqe-')).toBe('日本語');
  });

  test('several encoded runs separated by ASCII', () => {
    const name = '日本語 mail 台北';
    expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
  });

  test('an emoji survives, which means surrogate pairs do', () => {
    // Outside the BMP, so two UTF-16 code units — the case that breaks an
    // implementation working in code *points* rather than code units.
    const name = 'Travel 🇯🇵';
    expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
  });

  test('an unterminated run is passed through rather than thrown on', () => {
    // Not legal, and not worth failing a whole mailbox listing over.
    expect(() => decodeMailboxName('Broken &ZeVnLIqe')).not.toThrow();
  });

  test('decoding plain ASCII changes nothing', () => {
    expect(decodeMailboxName('INBOX/Drafts')).toBe('INBOX/Drafts');
  });
});
