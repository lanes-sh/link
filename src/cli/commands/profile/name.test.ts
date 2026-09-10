import { describe, expect, test } from 'bun:test';
import { assertProfileName, nearestProfileName } from './name.ts';

/**
 * The guard in front of the first write — issue #219.
 *
 * `profile.test.ts` holds the property that matters, which is that a refused
 * name leaves nothing on disk. This file holds the two things that are easier
 * to get wrong than to notice: that the rule here is the *same* rule the loader
 * applies, and that a suggestion is offered only when folding actually reaches
 * a name the rule accepts.
 */

describe('nearestProfileName', () => {
  test('folds the separators and cases people actually type', () => {
    expect(nearestProfileName('my-profile')).toBe('my_profile');
    expect(nearestProfileName('My Profile')).toBe('my_profile');
    expect(nearestProfileName('work.2')).toBe('work_2');
    expect(nearestProfileName('Personal')).toBe('personal');
  });

  test('drops punctuation, never a character that carries a word', () => {
    expect(nearestProfileName('-work')).toBe('work');
    // `fa` is a legal name and a different one, so this is a case with no
    // nearest name — only the rule, and a choice that is the operator's.
    expect(nearestProfileName('2fa')).toBeUndefined();
  });

  test('offers nothing rather than inventing a name', () => {
    expect(nearestProfileName('2026')).toBeUndefined();
    expect(nearestProfileName('---')).toBeUndefined();
    expect(nearestProfileName('')).toBeUndefined();
  });

  test('never suggests a name the guard would go on to refuse', () => {
    for (const name of ['my-profile', 'My Profile', 'work.2', '-work', '2fa', '---', '']) {
      const nearest = nearestProfileName(name);
      if (nearest !== undefined) expect(() => assertProfileName(nearest, 'local')).not.toThrow();
    }
  });
});

describe('assertProfileName', () => {
  test('accepts what the config contract accepts', () => {
    for (const name of ['personal', 'work', 'work_2', 'a']) {
      expect(() => assertProfileName(name, 'local')).not.toThrow();
    }
  });

  /**
   * The wording comes from the schema, and this is the test that keeps it
   * there. A second copy of the regex in the guard could accept a name the
   * loader refuses, which is the leftover again — reported by a different
   * sentence, one release later.
   */
  test("refuses with the loader's own wording", () => {
    expect(() => assertProfileName('my-profile', 'local')).toThrow(
      /must be lowercase letters, digits, and underscores, starting with a letter/,
    );
  });

  test('names the command that would have worked', () => {
    expect(() => assertProfileName('my-profile', 'cloud')).toThrow(
      'lanes link profile add my_profile --workspace cloud',
    );
  });

  test('falls back to a placeholder when the caller has no target yet', () => {
    expect(() => assertProfileName('my-profile')).toThrow(
      'lanes link profile add my_profile --workspace <name>',
    );
  });

  test('states the rule alone when nothing can be suggested', () => {
    expect(() => assertProfileName('2026', 'local')).toThrow(/must be lowercase letters/);
    expect(() => assertProfileName('2026', 'local')).not.toThrow(/Try:/);
  });

  test('says that nothing was written, which is the whole of the fix', () => {
    expect(() => assertProfileName('my-profile', 'local')).toThrow(/Nothing was written\./);
  });
});
