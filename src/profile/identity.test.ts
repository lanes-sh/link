import { describe, expect, test } from 'bun:test';
import { identityEntrySchema } from './identity.ts';
import { parseConfig } from './load.ts';

/**
 * The `identity` block.
 *
 * Most of this file is about one risk that is not obvious from the schema: this
 * is the first block in a profile that holds the owner's own prose, and every
 * value in a profile is walked by `secret-detection.ts` before the shape is even
 * checked. A note that tripped it would fail `parseConfig` — and there is
 * deliberately no suppression flag — so the profile would stop loading over a
 * sentence someone wrote about which name to use. The cases below pin both
 * directions: prose passes, and a credential pasted into a value does not.
 */

const PROFILE = `contract: 2
instance:
  profile: personal
connections:
  - { id: main, provider: identity, account: Identity }
policy:
  allow: [identity.*]
  deny: []
`;

/** The profile above, with an `identity` block appended. */
function withIdentity(block: string): string {
  return `${PROFILE}identity:\n${block}`;
}

describe('an entry', () => {
  test('takes any kind the owner cares to invent', () => {
    // An enum would mean a release every time someone wants `pronouns` or
    // `linkedin`, and there is nothing this schema could do with the knowledge
    // that a value is an email that would be worth that.
    for (const kind of ['name', 'email', 'github', 'pronouns', 'signing_key_id']) {
      expect(identityEntrySchema.safeParse({ kind, value: 'x' }).success).toBe(true);
    }
  });

  test('holds the kind to the identifier shape, so it can be read as one word', () => {
    for (const kind of ['Name', 'my kind', 'e-mail', '2fa', '']) {
      expect(identityEntrySchema.safeParse({ kind, value: 'x' }).success).toBe(false);
    }
  });

  test('needs a value, and a note is optional', () => {
    expect(identityEntrySchema.safeParse({ kind: 'name', value: '' }).success).toBe(false);
    expect(identityEntrySchema.safeParse({ kind: 'name', value: 'Ada' }).success).toBe(true);
    expect(
      identityEntrySchema.safeParse({ kind: 'name', value: 'Ada', note: 'for papers' }).success,
    ).toBe(true);
  });

  test('refuses an empty note rather than storing one', () => {
    // `note: ""` renders as a dangling em dash in every surface that shows it,
    // and means the same as leaving it out.
    expect(identityEntrySchema.safeParse({ kind: 'name', value: 'Ada', note: '' }).success).toBe(
      false,
    );
  });
});

describe('the block in a profile', () => {
  test('is optional, and absent means an empty list rather than undefined', () => {
    // Every reader of `config.identity` would otherwise need a guard, and the
    // one that forgot would throw on the common case: a profile that predates
    // this block entirely.
    expect(parseConfig(PROFILE).config.identity).toEqual([]);
  });

  test('keeps declaration order, because that order is the owner’s ranking', () => {
    const { config } = parseConfig(
      withIdentity(
        '  - { kind: name, value: Ada }\n' +
          '  - { kind: name, value: A. Lovelace }\n' +
          '  - { kind: email, value: ada@example.com }\n',
      ),
    );

    expect(config.identity.map((entry) => entry.value)).toEqual([
      'Ada',
      'A. Lovelace',
      'ada@example.com',
    ]);
  });

  test('refuses the same kind and value twice', () => {
    // The two would usually differ only in their note, so the entry that loses
    // is precisely the guidance someone wrote down to stop an agent picking
    // wrong — and losing it silently is how that guidance stops working.
    expect(() =>
      parseConfig(
        withIdentity(
          '  - { kind: name, value: Ada, note: for papers }\n' +
            '  - { kind: name, value: Ada, note: for code }\n',
        ),
      ),
    ).toThrow(/duplicate entry "name: Ada"/);
  });

  test('allows the same value under two kinds', () => {
    // A handle and a display name are routinely the same string, and they are
    // not the same fact.
    const { config } = parseConfig(
      withIdentity('  - { kind: name, value: octocat }\n  - { kind: github, value: octocat }\n'),
    );

    expect(config.identity).toHaveLength(2);
  });
});

describe('prose survives the secret scanner', () => {
  test('a long note about when to use a name parses', () => {
    // `looksHighEntropy` cannot fire on this: `OPAQUE_TOKEN` admits no spaces.
    // That is the property doing the work, so it gets a test rather than a
    // comment — a future tightening of that regex would break every profile
    // whose owner explained themselves at length, and this is what would say so.
    const note =
      'Use this one on anything published under the foundation, including talks, ' +
      'papers and release notes, but not on internal review threads where the ' +
      'shorter form reads better and everyone already knows who you are';

    const { config } = parseConfig(withIdentity(`  - { kind: name, value: Ada, note: "${note}" }\n`));

    expect(config.identity[0]?.note).toBe(note);
  });

  test('an address with a plus tag and dots parses', () => {
    const { config } = parseConfig(
      withIdentity('  - { kind: email, value: ada.lovelace+lanes@example.com }\n'),
    );

    expect(config.identity[0]?.value).toBe('ada.lovelace+lanes@example.com');
  });

  test('a credential pasted in as a value is still refused', () => {
    // Not a false positive to work around — the check working. Someone reaching
    // for `identity add github <token>` has misunderstood what this block is
    // for, and the config file is the last place that token should land.
    expect(() =>
      parseConfig(withIdentity('  - { kind: github, value: ghp_000000000000000000000000000000000000 }\n')),
    ).toThrow(/ghp_/);
  });
});
