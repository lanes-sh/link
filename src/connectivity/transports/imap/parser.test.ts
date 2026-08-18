import { describe, expect, test } from 'bun:test';
import { asText, itemValue, ResponseAssembler, tokenize, type ImapToken } from './parser.ts';

/** The items of a token that must be a list, so the tests read as assertions. */
const items = (token: ImapToken | undefined): readonly ImapToken[] => {
  if (!token || token.kind !== 'list') throw new Error(`expected a list, got ${token?.kind}`);
  return token.items;
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const assemble = (...chunks: string[]): Uint8Array[] => {
  const assembler = new ResponseAssembler();
  const out: Uint8Array[] = [];
  for (const chunk of chunks) {
    assembler.push(bytes(chunk));
    for (let response = assembler.next(); response; response = assembler.next()) {
      out.push(response);
    }
  }
  return out;
};

const text = (response: Uint8Array): string => new TextDecoder().decode(response);

describe('assembling responses', () => {
  test('a plain line is one response', () => {
    expect(assemble('* OK ready\r\n').map(text)).toEqual(['* OK ready\r\n']);
  });

  test('two lines in one chunk are two responses', () => {
    expect(assemble('* 1 EXISTS\r\n* 2 RECENT\r\n').map(text)).toEqual([
      '* 1 EXISTS\r\n',
      '* 2 RECENT\r\n',
    ]);
  });

  test('a line split across chunks waits for the rest', () => {
    expect(assemble('* OK re').map(text)).toEqual([]);
    expect(assemble('* OK re', 'ady\r\n').map(text)).toEqual(['* OK ready\r\n']);
  });

  test('a literal containing CRLF is not split — the bug this design exists for', () => {
    // Line-wise reading tears this into three, and what comes out looks like a
    // protocol error rather than a message body.
    const body = 'Subject: hi\r\n\r\nline one\r\nline two\r\n';
    const wire = `* 1 FETCH (BODY[] {${body.length}}\r\n${body})\r\n`;

    const [response] = assemble(wire);

    expect(text(response!)).toBe(wire);
  });

  test('a literal arriving in pieces is waited for', () => {
    const body = 'abcdefghij';
    const head = `* 1 FETCH (BODY[] {10}\r\n${body.slice(0, 4)}`;

    expect(assemble(head).map(text)).toEqual([]);
    expect(assemble(head, `${body.slice(4)})\r\n`).length).toBe(1);
  });

  test('two literals in one response are both counted', () => {
    const wire = '* 1 FETCH (BODY[HEADER] {5}\r\nabcde BODY[TEXT] {3}\r\nxyz)\r\n';

    expect(assemble(wire).map(text)).toEqual([wire]);
  });

  test('a LITERAL+ marker is understood', () => {
    const wire = '* 1 FETCH (BODY[] {4+}\r\nabcd)\r\n';

    expect(assemble(wire).map(text)).toEqual([wire]);
  });

  test('a byte that only looks like a literal marker is not one', () => {
    // `{}` with no digits, and a brace inside ordinary text.
    expect(assemble('* OK not a literal {}\r\n').map(text)).toEqual(['* OK not a literal {}\r\n']);
  });
});

describe('tokenising', () => {
  test('a LIST response, including the flag list', () => {
    const [response] = assemble('* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n');
    const tokens = tokenize(response!);

    expect(tokens[0]).toEqual({ kind: 'atom', value: '*' });
    expect(tokens[1]).toEqual({ kind: 'atom', value: 'LIST' });
    expect(items(tokens[2])).toHaveLength(2);
    expect(asText(tokens[4])).toBe('Sent Messages');
  });

  test('NIL is an absent value, not the three letters', () => {
    const [response] = assemble('* 1 FETCH (ENVELOPE ("date" NIL))\r\n');
    const envelope = items(itemValue(items(tokenize(response!)[3]), 'ENVELOPE'));

    expect(asText(envelope[0])).toBe('date');
    expect(asText(envelope[1])).toBeUndefined();
  });

  test('a bracketed item name survives with its spaces and parens', () => {
    // `BODY[HEADER.FIELDS (FROM DATE)]` is one item name. Splitting it on the
    // space would produce two names the server never sent.
    const [response] = assemble('* 1 FETCH (BODY[HEADER.FIELDS (FROM DATE)] {4}\r\nabcd)\r\n');
    const fetched = items(tokenize(response!)[3]);

    expect(asText(fetched[0])).toBe('BODY[HEADER.FIELDS (FROM DATE)]');
    expect(asText(itemValue(fetched, 'BODY'))).toBe('abcd');
  });

  test('a quoted string keeps its escaped quotes and backslashes', () => {
    const [response] = assemble('* 1 FETCH (SUBJECT "a \\"quote\\" and a \\\\")\r\n');
    expect(asText(itemValue(items(tokenize(response!)[3]), 'SUBJECT'))).toBe('a "quote" and a \\');
  });

  test('a literal body is kept as bytes, not decoded early', () => {
    // Decoding before the MIME layer has read the charset corrupts every
    // non-UTF-8 message in the box.
    const [response] = assemble('* 1 FETCH (BODY[] {4}\r\n\xc3\xa9ab)\r\n');
    const body = itemValue(items(tokenize(response!)[3]), 'BODY');

    expect(body?.kind).toBe('literal');
    expect(body?.kind === 'literal' && body.bytes.length).toBeGreaterThan(0);
  });

  test('a SEARCH result is a run of atoms', () => {
    const [response] = assemble('* SEARCH 1 4 9\r\n');
    const tokens = tokenize(response!);

    expect(tokens.slice(2).map((t) => asText(t))).toEqual(['1', '4', '9']);
  });

  test('a tagged completion keeps its response code as one atom', () => {
    const [response] = assemble('a0003 OK [READ-ONLY] EXAMINE completed\r\n');
    const tokens = tokenize(response!);

    expect(asText(tokens[0])).toBe('a0003');
    expect(asText(tokens[1])).toBe('OK');
    expect(asText(tokens[2])).toBe('[READ-ONLY]');
  });

  test("iCloud's greeting parses, capability bracket and all", () => {
    // Captured from imap.mail.me.com.
    const [response] = assemble(
      '* OK [CAPABILITY XAPPLEPUSHSERVICE IMAP4 IMAP4rev1 SASL-IR AUTH=ATOKEN AUTH=PLAIN] iCloud ready\r\n',
    );
    const tokens = tokenize(response!);

    expect(asText(tokens[2])).toContain('IMAP4rev1');
    expect(asText(tokens[2])).toContain('AUTH=PLAIN');
  });
});
