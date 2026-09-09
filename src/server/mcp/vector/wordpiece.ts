/**
 * The tokenizer the vendored table was built with, reimplemented.
 *
 * A static embedding table is a lookup, and a lookup is only as good as the
 * agreement between the keys it was built with and the keys it is asked for.
 * The table's rows are WordPiece pieces from `bge-base-en-v1.5`, so a text has
 * to be cut into pieces the same way or every row is the wrong row — silently,
 * because a wrong lookup still returns a vector.
 *
 * Reimplemented rather than depended upon, and the reason is the one
 * `CONTRIBUTING.md` asks for: the alternative is a tokenizer library, which
 * arrives with a model loader, an ONNX runtime and a download step, in a
 * repository that holds live refresh tokens and enforces a release-age floor on
 * everything it installs. This is ninety lines of string handling with no I/O,
 * and `wordpiece.test.ts` pins it against the reference implementation's output
 * for the vocabulary this endpoint actually sees.
 *
 * Three stages, in the order the reference applies them: normalise, split into
 * words, then cut each word into the longest pieces the vocabulary holds.
 */

/**
 * What the table's normaliser does, which is not merely `toLowerCase`.
 *
 * `clean_text` drops the characters that cannot be part of a word — the null
 * byte, the replacement character, and the C0/C1 control range — and flattens
 * every other kind of whitespace to a plain space. Tabs and newlines reach this
 * constantly: a capability description is prose with line breaks in it.
 *
 * Accents come off because the checkpoint's `strip_accents` is unset, and unset
 * follows `lowercase` in the reference. NFD splits a letter from its combining
 * marks and the marks are then dropped, so `café` and `cafe` are one word.
 */
export function normalize(text: string): string {
  let cleaned = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code === 0xfffd) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // A control character is not whitespace and not a letter. Tab, newline
      // and carriage return are the three the reference keeps, as spaces.
      if (code === 0x09 || code === 0x0a || code === 0x0d) cleaned += ' ';
      continue;
    }
    cleaned += /\s/.test(character) ? ' ' : character;
  }

  return cleaned
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();
}

/**
 * Words, with punctuation standing alone.
 *
 * `users.messages.list` has to become three words and two dots rather than one
 * unknown word, and that is the whole reason punctuation is split off rather
 * than stripped: a capability id is punctuation-separated, and the identifiers
 * on either side of a dot are exactly the tokens worth matching.
 *
 * The punctuation test is the reference's: every ASCII symbol, plus anything
 * Unicode files under P. Digits and letters are not punctuation, so `v3` and
 * `oauth2` survive whole.
 */
export function split(text: string): string[] {
  const words: string[] = [];
  let current = '';

  for (const character of normalize(text)) {
    if (character === ' ') {
      if (current) words.push(current);
      current = '';
      continue;
    }
    if (isPunctuation(character)) {
      if (current) words.push(current);
      current = '';
      words.push(character);
      continue;
    }
    current += character;
  }
  if (current) words.push(current);

  return words;
}

function isPunctuation(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  const ascii =
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126);
  return ascii || /\p{P}|\p{S}/u.test(character);
}

/** The longest piece in the vocabulary, and where the remainder starts. */
function longest(word: string, from: number, vocabulary: ReadonlyMap<string, number>): number {
  for (let end = word.length; end > from; end--) {
    const piece = from === 0 ? word.slice(from, end) : `##${word.slice(from, end)}`;
    if (vocabulary.has(piece)) return end;
  }
  return -1;
}

/**
 * A text as the rows it addresses.
 *
 * Greedy longest-match-first, which is what WordPiece is: take the longest
 * prefix the vocabulary holds, then keep taking the longest continuation until
 * the word is used up. A word with no valid cut is one unknown token rather
 * than a bag of single letters — the reference's rule, and the one that keeps a
 * base64 blob in a description from contributing thirty characters of noise.
 *
 * Unknown tokens are dropped rather than looked up. `[UNK]` has a row and that
 * row means "some word I have never seen", which is a claim about the
 * *tokenizer* rather than about the text; averaging it in pulls every text
 * containing an unusual identifier towards every other one.
 */
export function pieces(text: string, vocabulary: ReadonlyMap<string, number>): number[] {
  const rows: number[] = [];

  for (const word of split(text)) {
    if (word.length > MAX_WORD) continue;

    const cuts: number[] = [];
    let at = 0;
    let failed = false;
    while (at < word.length) {
      const end = longest(word, at, vocabulary);
      if (end === -1) {
        failed = true;
        break;
      }
      const piece = at === 0 ? word.slice(at, end) : `##${word.slice(at, end)}`;
      cuts.push(vocabulary.get(piece) as number);
      at = end;
    }
    if (!failed) rows.push(...cuts);
  }

  return rows;
}

/** Past this a "word" is a blob, and the reference gives up rather than cut it. */
const MAX_WORD = 100;
