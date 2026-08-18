/**
 * Modified UTF-7, the encoding IMAP mailbox names arrive in (RFC 3501 §5.1.3).
 *
 * A mailbox called `Wichtig` is fine on the wire; one called `Wichtig ✓` is
 * `Wichtig &Ivg-`, and a Japanese folder is unreadable without this. Getting it
 * wrong is not subtle in one direction and dangerously subtle in the other:
 * skipping *decode* shows an agent a folder name nobody recognises, while
 * skipping *encode* sends a `SELECT` for a mailbox the server does not have, and
 * a `SELECT` that fails looks exactly like a mailbox that is empty.
 *
 * It is UTF-7 with two changes: `+` becomes `&` (because `+` is common in
 * mailbox names), and `/` becomes `,` (because `/` is the usual hierarchy
 * delimiter). Padding is omitted.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';

/** Wire form → the name a person would recognise. */
export function decodeMailboxName(encoded: string): string {
  let out = '';
  let index = 0;

  while (index < encoded.length) {
    const amp = encoded.indexOf('&', index);
    if (amp === -1) return out + encoded.slice(index);

    out += encoded.slice(index, amp);

    const end = encoded.indexOf('-', amp + 1);
    if (end === -1) {
      // Unterminated: not legal, and not worth throwing over — a mailbox list
      // is not the place to fail a whole call. Pass the rest through as-is.
      return out + encoded.slice(amp);
    }

    const chunk = encoded.slice(amp + 1, end);
    // `&-` is how a literal ampersand is written.
    out += chunk === '' ? '&' : fromModifiedBase64(chunk);
    index = end + 1;
  }

  return out;
}

/** The name a person typed → wire form. */
export function encodeMailboxName(name: string): string {
  let out = '';
  let run = '';

  const flush = (): void => {
    if (run === '') return;
    out += `&${toModifiedBase64(run)}-`;
    run = '';
  };

  for (const character of name) {
    const code = character.codePointAt(0)!;

    if (character === '&') {
      flush();
      out += '&-';
      continue;
    }

    // Printable US-ASCII represents itself; everything else goes to base64.
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += character;
      continue;
    }

    run += character;
  }

  flush();
  return out;
}

/** Modified base64 → text, by way of the UTF-16BE the bytes represent. */
function fromModifiedBase64(chunk: string): string {
  let bits = 0;
  let width = 0;
  const units: number[] = [];
  let pending = 0;
  let pendingBits = 0;

  for (const character of chunk) {
    const value = BASE64.indexOf(character);
    if (value === -1) continue; // Not representable; skipping beats throwing.

    bits = (bits << 6) | value;
    width += 6;

    while (width >= 8) {
      width -= 8;
      const byte = (bits >> width) & 0xff;
      pending = (pending << 8) | byte;
      pendingBits += 8;

      if (pendingBits === 16) {
        units.push(pending & 0xffff);
        pending = 0;
        pendingBits = 0;
      }
    }
  }

  // Surrogate pairs survive because they are two code units and this rebuilds
  // code units, not code points.
  return String.fromCharCode(...units);
}

/** Text → modified base64 of its UTF-16BE bytes. */
function toModifiedBase64(text: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    bytes.push((unit >> 8) & 0xff, unit & 0xff);
  }

  let out = '';
  let bits = 0;
  let width = 0;

  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    width += 8;
    while (width >= 6) {
      width -= 6;
      out += BASE64[(bits >> width) & 0x3f];
    }
  }

  if (width > 0) out += BASE64[(bits << (6 - width)) & 0x3f];
  return out;
}
