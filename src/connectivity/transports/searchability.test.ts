import { describe, expect, test } from 'bun:test';
import { titleFor, withKeywords } from './index.ts';

/**
 * The two fields a client's tool search actually reads.
 *
 * Tool search is client-side and ranks on names and descriptions, so those are
 * the whole index (ADR-075). Neither of the helpers here changes what a tool
 * *does*, which is why they need tests: a mistake in either is invisible at
 * runtime and shows up only as a tool nobody picks.
 */

describe('titleFor', () => {
  /**
   * The reversal is the point. An operationId is a path, so it reads
   * object-then-verb; a person says the verb first.
   */
  test('reads the operation as a person would say it', () => {
    expect(titleFor('Gmail', 'users.drafts.list')).toBe('Gmail: list drafts');
    expect(titleFor('Google Sheets', 'spreadsheets.values.update')).toBe(
      'Google Sheets: update values',
    );
  });

  test('splits camelCase and separators into words', () => {
    expect(titleFor('Google Sheets', 'spreadsheets.sheets.copyTo')).toBe(
      'Google Sheets: copy to sheets',
    );
    expect(titleFor('Slack', 'conversations_history')).toBe('Slack: conversations history');
  });

  /**
   * Only the last two segments. `users.` prefixes most of Gmail and distinguishes
   * nothing, so joining every segment would spend bytes to say less.
   */
  test('ignores segments above the object', () => {
    expect(titleFor('Gmail', 'users.messages.attachments.get')).toBe('Gmail: get attachments');
  });

  test('a single segment is just the verb', () => {
    expect(titleFor('Tavily', 'search')).toBe('Tavily: search');
  });

  /**
   * Degenerate input yields the vendor rather than a title with a dangling
   * colon. Nothing produces this today; it is here so that nothing has to.
   */
  test('an empty name falls back to the vendor', () => {
    expect(titleFor('Notion', '')).toBe('Notion');
    expect(titleFor('Notion', '...')).toBe('Notion');
  });
});

describe('withKeywords', () => {
  test('appends the terms a description does not already carry', () => {
    expect(withKeywords('Lists the drafts in the mailbox.', ['email', 'inbox'])).toBe(
      'Lists the drafts in the mailbox.\n\nAlso: email, inbox.',
    );
  });

  /**
   * The filter is what keeps the line to what is missing. Without it every
   * description would restate words already in it, and the line would grow
   * rather than shrink as vendors improve their own wording.
   */
  test('drops a term the description already uses, whatever the case', () => {
    expect(withKeywords('Send an Email to a recipient.', ['email', 'inbox'])).toBe(
      'Send an Email to a recipient.\n\nAlso: inbox.',
    );
  });

  test('leaves a description alone when nothing is missing', () => {
    const description = 'Search email in the inbox.';
    expect(withKeywords(description, ['email', 'inbox'])).toBe(description);
    expect(withKeywords(description)).toBe(description);
    expect(withKeywords(description, [])).toBe(description);
  });

  /**
   * Whole words only. `mail` must not be considered present because `mailbox`
   * is — they are different search terms, and treating one as the other is how
   * a provider ends up with no vocabulary for the thing it is.
   */
  test('matches whole words rather than substrings', () => {
    expect(withKeywords('Lists the mailbox labels.', ['mail'])).toBe(
      'Lists the mailbox labels.\n\nAlso: mail.',
    );
  });

  /** A term is written by an operator in a manifest, so it may contain anything. */
  test('a term with regex punctuation is matched literally', () => {
    expect(withKeywords('Reads a file.', ['e-mail', 'c++'])).toBe(
      'Reads a file.\n\nAlso: e-mail, c++.',
    );
  });

  test('a multi-word term is one term', () => {
    expect(withKeywords('Look up a saved contact.', ['address book'])).toBe(
      'Look up a saved contact.\n\nAlso: address book.',
    );
    expect(withKeywords('Search the address book.', ['address book'])).toBe(
      'Search the address book.',
    );
  });
});
