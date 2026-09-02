/**
 * Reading IMAP responses.
 *
 * The one thing that must not be done line-wise. A response may announce a
 * literal — `{1234}` at the end of a line — and the next 1234 bytes are then
 * *arbitrary*: a message body containing CRLF, quotes, parentheses, and NUL. A
 * reader that splits on CRLF tears those apart and produces garbage that looks
 * like a protocol error, which is why this assembles by counting bytes and only
 * then tokenises.
 *
 * Bytes rather than strings all the way through, because `BODY[]` is the raw
 * RFC 822 message and decoding it as UTF-8 before the MIME layer has read its
 * charset would corrupt every non-UTF-8 mail in the box.
 */

const CR = 0x0d;
const LF = 0x0a;

/**
 * The most this will accumulate before refusing a response.
 *
 * A literal's length is a number the *server* writes — `{1234}` — and the
 * reader's job is to wait until that many bytes have arrived. With no ceiling
 * that is an allocation an upstream decides the size of, and the upstream is
 * not always one this endpoint chose: a connector names its own host, so a
 * connection pointed at a hostile or compromised server could announce a
 * literal of any size and be believed.
 *
 * Sixty-four mebibytes because that is already the ceiling on the other side of
 * the same journey — `MAX_UPLOAD_BYTES` in `server/attachments.ts` — and a
 * message larger than the largest attachment this endpoint will accept is not
 * one it can do anything useful with. Every mail host's own limit is well below
 * it, so this is never what refuses a legitimate read.
 *
 * Applied twice, and both are needed. The announced length is refused up front,
 * so an absurd number costs nothing rather than being discovered after the
 * bytes arrive. The accumulated buffer is refused too, because one response may
 * announce several literals and a server that never completes a response would
 * otherwise grow this without ever announcing anything unreasonable.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** A parsed element of a response. */
export type ImapToken =
  | { readonly kind: 'atom'; readonly value: string }
  | { readonly kind: 'quoted'; readonly value: string }
  | { readonly kind: 'literal'; readonly bytes: Uint8Array }
  | { readonly kind: 'list'; readonly items: readonly ImapToken[] };

/**
 * Accumulates bytes and hands back one complete logical response at a time.
 *
 * "Logical" is the important word: a single response can span several physical
 * lines whenever a literal is involved, and it is not complete until every
 * announced literal has arrived in full.
 */
export class ResponseAssembler {
  #buffer = new Uint8Array(0);
  /** Bytes in use. The buffer is grown ahead of this and is not a length. */
  #length = 0;

  /**
   * Take a chunk off the socket.
   *
   * Capacity doubles rather than growing to fit. It used to allocate exactly
   * `held + chunk` and copy everything across on every chunk, which is
   * quadratic in the size of a response — a thirty-megabyte message arriving in
   * sixty-four-kilobyte pieces copied several gigabytes to assemble, and that
   * was the *legitimate* case. Doubling makes each byte move a constant number
   * of times.
   */
  push(chunk: Uint8Array): void {
    const needed = this.#length + chunk.length;
    if (needed > MAX_RESPONSE_BYTES) {
      throw new Error(
        `The server sent more than ${MAX_RESPONSE_BYTES} bytes without completing a response.`,
      );
    }

    if (needed > this.#buffer.length) {
      let capacity = Math.max(this.#buffer.length, 8192);
      while (capacity < needed) capacity *= 2;

      const grown = new Uint8Array(Math.min(capacity, MAX_RESPONSE_BYTES));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }

    this.#buffer.set(chunk, this.#length);
    this.#length = needed;
  }

  /** The next complete response, or undefined while more bytes are needed. */
  next(): Uint8Array | undefined {
    const end = completeResponseEnd(this.#buffer.subarray(0, this.#length));
    if (end === undefined) return undefined;

    // A copy, not a view: the remainder is shifted down in place below, which
    // would otherwise rewrite the bytes underneath the response just returned.
    const response = this.#buffer.slice(0, end);
    this.#buffer.copyWithin(0, end, this.#length);
    this.#length -= end;
    return response;
  }

  /** Whatever has arrived but does not yet form a response. For diagnostics. */
  get pending(): number {
    return this.#length;
  }
}

/** Where a complete response ends, counting past every literal it announces. */
function completeResponseEnd(buffer: Uint8Array): number | undefined {
  let cursor = 0;

  for (;;) {
    const crlf = indexOfCrlf(buffer, cursor);
    if (crlf === -1) return undefined;

    const announced = literalLength(buffer, cursor, crlf);
    if (announced === undefined) return crlf + 2;

    // Refused on the announcement rather than after the bytes turn up: the
    // number is the server's, and believing an absurd one means waiting for it.
    if (announced > MAX_RESPONSE_BYTES) {
      throw new Error(
        `The server announced a ${announced}-byte literal, over the ${MAX_RESPONSE_BYTES}-byte limit.`,
      );
    }

    const afterLiteral = crlf + 2 + announced;
    if (buffer.length < afterLiteral) return undefined;

    // The literal is in hand; the response continues after it, and may announce
    // another — `BODY[HEADER] {12} ... BODY[TEXT] {900} ...` in one FETCH.
    cursor = afterLiteral;
  }
}

function indexOfCrlf(buffer: Uint8Array, from: number): number {
  for (let index = from; index + 1 < buffer.length; index++) {
    if (buffer[index] === CR && buffer[index + 1] === LF) return index;
  }
  return -1;
}

/**
 * The size a line announces, if it ends in a literal marker.
 *
 * `{123}` or `{123+}` — the `+` form is LITERAL+, which a server uses to say it
 * is not waiting for a continuation.
 */
function literalLength(buffer: Uint8Array, from: number, crlf: number): number | undefined {
  let index = crlf - 1;
  if (index < from) return undefined;

  // Read right to left: `}`, then an optional `+` *inside* the braces, then the
  // digits, then `{`.
  if (buffer[index] !== 0x7d /* } */) return undefined;
  index--;
  if (index >= from && buffer[index] === 0x2b /* + */) index--; // LITERAL+

  let digits = '';
  while (index >= from && buffer[index]! >= 0x30 && buffer[index]! <= 0x39) {
    digits = String.fromCharCode(buffer[index]!) + digits;
    index--;
  }

  if (digits === '' || index < from || buffer[index] !== 0x7b /* { */) return undefined;
  return Number(digits);
}

/**
 * Turn one complete response into tokens.
 *
 * Brackets are deliberately kept inside atoms: `BODY[HEADER.FIELDS (FROM DATE)]`
 * is *one* item name, parentheses and all, and splitting it on the space would
 * turn the FETCH item into two unrecognisable ones.
 */
export function tokenize(response: Uint8Array): ImapToken[] {
  const state = { at: 0 };
  const tokens = readTokens(response, state, null);
  return tokens;
}

function readTokens(
  buffer: Uint8Array,
  state: { at: number },
  closer: number | null,
): ImapToken[] {
  const tokens: ImapToken[] = [];

  while (state.at < buffer.length) {
    const byte = buffer[state.at]!;

    if (byte === CR || byte === LF) {
      // A bare CRLF ends the response; inside a list it is part of a literal's
      // surroundings and simply skipped.
      state.at++;
      if (closer === null) break;
      continue;
    }

    if (byte === 0x20 /* space */) {
      state.at++;
      continue;
    }

    if (closer !== null && byte === closer) {
      state.at++;
      break;
    }

    if (byte === 0x28 /* ( */) {
      state.at++;
      tokens.push({ kind: 'list', items: readTokens(buffer, state, 0x29 /* ) */) });
      continue;
    }

    if (byte === 0x22 /* " */) {
      tokens.push({ kind: 'quoted', value: readQuoted(buffer, state) });
      continue;
    }

    if (byte === 0x7b /* { */) {
      const literal = readLiteral(buffer, state);
      if (literal) {
        tokens.push({ kind: 'literal', bytes: literal });
        continue;
      }
    }

    tokens.push({ kind: 'atom', value: readAtom(buffer, state, closer) });
  }

  return tokens;
}

function readQuoted(buffer: Uint8Array, state: { at: number }): string {
  state.at++; // opening quote
  const bytes: number[] = [];

  while (state.at < buffer.length) {
    const byte = buffer[state.at]!;
    if (byte === 0x5c /* \ */ && state.at + 1 < buffer.length) {
      bytes.push(buffer[state.at + 1]!);
      state.at += 2;
      continue;
    }
    if (byte === 0x22) {
      state.at++;
      break;
    }
    bytes.push(byte);
    state.at++;
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function readLiteral(buffer: Uint8Array, state: { at: number }): Uint8Array | undefined {
  const close = buffer.indexOf(0x7d /* } */, state.at);
  if (close === -1) return undefined;

  const header = new TextDecoder().decode(buffer.subarray(state.at + 1, close));
  const size = Number(header.replace('+', ''));
  if (!Number.isFinite(size)) return undefined;

  // The size is followed by CRLF, then exactly `size` bytes.
  let start = close + 1;
  if (buffer[start] === CR) start++;
  if (buffer[start] === LF) start++;

  const end = Math.min(start + size, buffer.length);
  state.at = end;
  return buffer.subarray(start, end);
}

function readAtom(buffer: Uint8Array, state: { at: number }, closer: number | null): string {
  const start = state.at;
  let brackets = 0;

  while (state.at < buffer.length) {
    const byte = buffer[state.at]!;

    if (byte === 0x5b /* [ */) brackets++;
    else if (byte === 0x5d /* ] */) brackets--;
    else if (brackets === 0) {
      if (byte === 0x20 || byte === CR || byte === LF) break;
      if (byte === 0x28 || byte === 0x29) break;
      if (closer !== null && byte === closer) break;
    }

    state.at++;
  }

  return new TextDecoder().decode(buffer.subarray(start, state.at));
}

// ---------------------------------------------------------------------------
// Reading what was parsed
// ---------------------------------------------------------------------------

/** The text of any token that has one. `NIL` is an absent value, not the word. */
export function asText(token: ImapToken | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'atom') return token.value === 'NIL' ? undefined : token.value;
  if (token.kind === 'quoted') return token.value;
  if (token.kind === 'literal') return new TextDecoder().decode(token.bytes);
  return undefined;
}

/**
 * The value following a named item, as FETCH lays them out.
 *
 * A FETCH response is a flat alternation — `UID 5 FLAGS (\Seen) RFC822.SIZE 42`
 * — so an item's value is simply the token after its name. Matching is prefix-
 * based because `BODY[]` and `BODY[HEADER.FIELDS (DATE)]` are different names
 * for the same request depending on what was asked for.
 */
export function itemValue(
  items: readonly ImapToken[],
  name: string,
): ImapToken | undefined {
  for (let index = 0; index < items.length; index++) {
    const token = items[index]!;
    if (token.kind !== 'atom') continue;
    if (token.value === name || token.value.toUpperCase().startsWith(`${name.toUpperCase()}[`)) {
      return items[index + 1];
    }
  }
  return undefined;
}
