import { describe, expect, test } from 'bun:test';
import { defineProvider } from './provider.ts';
import { applyVariables, placeholdersInConnector } from './variables.ts';

/**
 * Where a service lives, when the connection decides.
 *
 * The two halves are tested separately on purpose. `defineProvider` catches a
 * manifest whose placeholders and variables disagree, which is a mistake made
 * once by whoever writes the provider. `applyVariables` guards the *value*,
 * which arrives from a config file that can be edited by hand and is read by a
 * deployed revision that never sees a prompt — so it is the one that has to hold
 * against something hostile rather than merely careless.
 */

const HOST = {
  key: 'site',
  label: 'subdomain',
  description: 'The first part of your address.',
  example: 'acme',
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
};

describe('finding placeholders', () => {
  test('reaches a nested field, not just the top level', () => {
    // The imap connector puts submission a level down, and a field list missed
    // it — a generic mailbox was refused for a variable it plainly used.
    const found = placeholdersInConnector({
      kind: 'imap',
      host: '{imap_host}',
      smtp: { host: '{smtp_host}', port: 587 },
    });

    expect(found.sort()).toEqual(['imap_host', 'smtp_host']);
  });

  test('a connector with no placeholders finds none', () => {
    expect(placeholdersInConnector({ kind: 'http', base_url: 'https://api.example.com' })).toEqual(
      [],
    );
  });
});

describe('substituting a value', () => {
  test('fills every occurrence, however deep', () => {
    const filled = applyVariables(
      { kind: 'imap', host: '{site}.mail.example.com', smtp: { host: '{site}.smtp.example.com' } },
      [HOST],
      { site: 'acme' },
    );

    expect(filled['host']).toBe('acme.mail.example.com');
    expect((filled['smtp'] as { host: string }).host).toBe('acme.smtp.example.com');
  });

  test('a manifest with no variables is returned untouched', () => {
    const connector = { kind: 'http', base_url: 'https://api.example.com' };

    expect(applyVariables(connector, [], {})).toBe(connector);
  });

  test('a missing value says which one, and what it looks like', () => {
    expect(() => applyVariables({ kind: 'dav', base_url: 'https://{site}' }, [HOST], {})).toThrow(
      /does not say what "site" is/,
    );
  });

  test('a value that would change the host is refused rather than sent', () => {
    // The whole reason the pattern exists. Each of these keeps the manifest
    // reading as one vendor while pointing the operator's credential at
    // another, or at a path that is not the API at all.
    for (const hostile of [
      'acme.evil.test',
      'acme/../../evil',
      'acme@evil.test',
      'acme:8080',
      'acme?x=',
      'acme#',
    ]) {
      expect(() =>
        applyVariables({ kind: 'http', base_url: 'https://{site}.example.com' }, [HOST], {
          site: hostile,
        }),
      ).toThrow(/not a usable subdomain/);
    }
  });

  test('a provider whose value is a whole hostname says so with its own pattern', () => {
    // Self-hosted: there is no domain to escape, because the manifest names
    // none. What the pattern still refuses is anything that is not a hostname.
    const anywhere = { ...HOST, key: 'host', label: 'server', pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' };

    expect(
      applyVariables({ kind: 'dav', base_url: 'https://{host}' }, [anywhere], {
        host: 'cloud.example.com',
      })['base_url'],
    ).toBe('https://cloud.example.com');

    expect(() =>
      applyVariables({ kind: 'dav', base_url: 'https://{host}' }, [anywhere], {
        host: 'cloud.example.com/../evil',
      }),
    ).toThrow(/not a usable server/);
  });
});

describe('a manifest declaring variables', () => {
  const base = {
    id: 'thing',
    name: 'Thing',
    connector: { kind: 'dav', base_url: 'https://{site}.example.com', service: 'caldav' },
    auth: { kind: 'basic' },
    setup: {
      prompts: [
        { key: 'username', label: 'User', scope: 'connection', field: 'username' },
        { key: 'password', label: 'Password', secret: true, scope: 'connection', field: 'password' },
      ],
    },
  };

  test('is accepted when the two halves agree', () => {
    expect(defineProvider({ ...base, variables: [HOST] }).variables).toHaveLength(1);
  });

  test('a placeholder nothing fills is refused', () => {
    // Otherwise the braces reach the vendor verbatim and it fails as DNS,
    // which says nothing about the real problem.
    expect(() => defineProvider(base)).toThrow(/names \{site\} and the manifest declares no variable/);
  });

  test('a variable nothing uses is refused', () => {
    // The quieter of the two: connect asks the operator a question, stores the
    // answer, and nothing ever reads it.
    expect(() =>
      defineProvider({
        ...base,
        connector: { kind: 'dav', base_url: 'https://fixed.example.com', service: 'caldav' },
        variables: [HOST],
      }),
    ).toThrow(/appears in no address/);
  });

  test('a local provider cannot declare one, because it has no address', () => {
    expect(() =>
      defineProvider({
        id: 'thing',
        name: 'Thing',
        connector: { kind: 'local' },
        auth: { kind: 'none' },
        variables: [HOST],
      }),
    ).toThrow(/no address to fill in/);
  });
});

describe('the pattern is a control, not a hint', () => {
  const withPattern = (pattern: string) =>
    defineProvider({
      id: 'thing',
      name: 'Thing',
      connector: { kind: 'dav', base_url: 'https://{site}.example.com', service: 'caldav' },
      auth: { kind: 'basic' },
      variables: [{ ...HOST, pattern }],
      setup: {
        prompts: [
          { key: 'username', label: 'User', scope: 'connection', field: 'username' },
          { key: 'password', label: 'Password', secret: true, scope: 'connection', field: 'password' },
        ],
      },
    });

  test('an unanchored one is anchored, because test matches a substring', () => {
    // Written as a hint, it would accept `acme.evil.test/@x` — which is then
    // put into the URL the credential is sent to.
    const manifest = withPattern('[a-z.]+');

    expect(manifest.variables[0]?.pattern).toBe('^(?:[a-z.]+)$');
    expect(() =>
      applyVariables({ kind: 'dav', base_url: 'https://{site}.example.com' }, manifest.variables, {
        site: 'acme.evil.test/@x',
      }),
    ).toThrow(/not a usable/);
  });

  test('one that is already anchored is left alone', () => {
    expect(withPattern('^[a-z]+$').variables[0]?.pattern).toBe('^[a-z]+$');
  });

  test('an invalid one is refused at load, not at the first call', () => {
    expect(() => withPattern('[unclosed')).toThrow(/not a usable regular expression/);
  });
});
