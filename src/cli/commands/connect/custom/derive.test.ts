import { describe, expect, test } from 'bun:test';
import { parseManifest } from '#providers/custom/index.ts';
import { strategyFor } from '#connectivity';
import { buildRegistry } from '../../../runtime/registry.ts';
import { deriveDeclaration, deriveManifest, parseAuthMethod, parseConnectorKind } from './derive.ts';
import { renderManifest } from './write.ts';
import {
  AUTH_METHODS,
  CONNECTOR_KINDS,
  type AuthMethod,
  type ConnectorKind,
  type CustomAnswers,
} from './spec.ts';

/**
 * That composing the two fixed lists produces a manifest that can actually
 * connect — not merely one that validates.
 *
 * The distinction is the whole point of this file. `defineProvider` refuses a
 * manifest whose *shape* is wrong, and there are several ways to be shaped
 * correctly and still be unusable: a credential type the transport has nowhere
 * to put, an OAuth block with no client to present, a prompt key nothing looks
 * up. Each of those fails after a credential has been stored or a consent screen
 * approved, so each is refused here instead.
 */

/** The minimum each pair needs said, and nothing more. */
const REQUIRED: Record<ConnectorKind, Record<string, string | readonly string[]>> = {
  mcp: { endpoint: 'https://mcp.example.com/mcp' },
  http: { 'base-url': 'https://api.example.com/v1', openapi: 'https://api.example.com/openapi.json' },
  imap: { host: 'imap.example.com' },
  dav: { 'base-url': 'https://dav.example.com', service: 'caldav' },
  fs: { root: '~/Notes' },
};

const AUTH_REQUIRED: Partial<Record<AuthMethod, Record<string, string | readonly string[]>>> = {
  header: { 'auth-header': 'X-Api-Key' },
  oauth: { scopes: ['read'] },
  strategy: { strategy: 'handshake' },
};

function answers(
  connector: ConnectorKind,
  auth: AuthMethod,
  extra: Record<string, string | readonly string[]> = {},
): CustomAnswers {
  return {
    id: 'thing',
    name: 'Thing',
    connector,
    auth,
    values: { ...REQUIRED[connector], ...(AUTH_REQUIRED[auth] ?? {}), ...extra },
  };
}

/** Everything `defineProvider` permits, worked out from its own rules. */
const LEGAL: ReadonlyArray<[ConnectorKind, AuthMethod]> = [
  ['mcp', 'none'],
  ['mcp', 'bearer'],
  ['mcp', 'oauth'],
  ['http', 'none'],
  ['http', 'bearer'],
  ['http', 'api-key'],
  ['http', 'header'],
  ['http', 'basic'],
  ['http', 'oauth'],
  ['http', 'strategy'],
  ['imap', 'basic'],
  ['dav', 'basic'],
  ['fs', 'none'],
];

/** An http OAuth provider needs its endpoints; see `oauthBlock`. */
const endpoints = {
  'authorize-url': 'https://auth.example.com/authorize',
  'token-url': 'https://auth.example.com/token',
};

const forPair = (connector: ConnectorKind, auth: AuthMethod): CustomAnswers =>
  answers(connector, auth, connector === 'http' && auth === 'oauth' ? endpoints : {});

describe('every legal pairing of the two fixed lists', () => {
  test('the matrix under test is the one the schema actually permits', () => {
    // Derived rather than asserted, so a rule relaxed in `defineProvider` shows
    // up here as a pair this file forgot rather than as nothing at all.
    const pairs = CONNECTOR_KINDS.flatMap((connector) =>
      AUTH_METHODS.map((auth) => [connector, auth] as const),
    );

    const accepted = pairs.filter(([connector, auth]) => {
      try {
        deriveManifest(forPair(connector, auth));
        return true;
      } catch {
        return false;
      }
    });

    expect(accepted.map(([c, a]) => `${c}+${a}`).sort()).toEqual(
      LEGAL.map(([c, a]) => `${c}+${a}`).sort(),
    );
  });

  test.each(LEGAL)('%s + %s round-trips through the loader', (connector, auth) => {
    // The assertion that matters most in this file: the text this command writes
    // is re-read by the exact code the loader runs — entropy check, schema,
    // every cross-field rule — and comes back the same manifest. A declaration
    // that cannot survive being read back is not a declaration.
    const written = renderManifest(deriveDeclaration(forPair(connector, auth)));

    expect(parseManifest(written, 'derived.yaml')).toEqual(deriveManifest(forPair(connector, auth)));
  });

  test.each(LEGAL)('%s + %s can be connected, not just validated', (connector, auth) => {
    const manifest = deriveManifest(forPair(connector, auth));

    // `ensureStaticCredential` throws for a credential that is asked for rather
    // than granted and finds no per-connection prompt. `none` is granted by the
    // operating system or by nothing; `oauth` comes back from a browser.
    const asked = auth !== 'none' && auth !== 'oauth';
    const perAccount = (manifest.setup?.prompts ?? []).filter((p) => p.scope === 'connection');

    expect(perAccount.length > 0).toBe(asked);
  });
});

describe('a pairing the transport cannot carry', () => {
  test('an mcp connector says where the credential would have gone, and what to use', () => {
    for (const auth of ['api-key', 'header', 'basic'] as const) {
      expect(() => deriveManifest(answers('mcp', auth))).toThrow(
        /nowhere else on the request[\s\S]*--connector http/,
      );
    }
  });

  test('a mailbox and a calendar name the method that works', () => {
    for (const connector of ['imap', 'dav'] as const) {
      expect(() => deriveManifest(answers(connector, 'bearer'))).toThrow(/Use --auth basic/);
      expect(() => deriveManifest(answers(connector, 'oauth'))).toThrow(/partner-gated/);
    }
  });

  test('a folder holds no account', () => {
    expect(() => deriveManifest(answers('fs', 'bearer'))).toThrow(/Use --auth none/);
  });
});

describe('the one union member an operator cannot use', () => {
  test('local is ours, and says so', () => {
    expect(() => parseConnectorKind('local')).toThrow(/compiled into this build/);
  });

  test('and an unknown name lists what there is', () => {
    expect(() => parseConnectorKind('graphql')).toThrow(/mcp, http, imap, dav, fs/);
    expect(() => parseAuthMethod('sigv4')).toThrow(/none, bearer, api-key, header, basic, oauth/);
  });
});

describe('an auth strategy', () => {
  /**
   * A strategy names code that travels on a provider's definition, so a
   * declaration-only manifest reaches one by name — which is the only way to
   * point a connection at a vendor's sandbox, since a built-in manifest's
   * `options` are not the operator's to edit (ADR-046).
   */
  test('is named, and its options are passed through untouched', () => {
    const manifest = deriveManifest(
      answers('http', 'strategy', { 'strategy-option': ['environment=sandbox', 'retries=2'] }),
    );

    expect(manifest.auth).toMatchObject({
      kind: 'strategy',
      strategy: 'handshake',
      options: { environment: 'sandbox', retries: '2' },
    });
  });

  test('whether the name resolves is the registry\'s answer, not this file\'s', () => {
    // Deliberately not validated here. `strategyFor` looks at this manifest's own
    // definition and then at every registered provider's, and `refuseStrategy`
    // is what says a name reaches nothing — this file has no registry to ask.
    expect(() => deriveManifest(answers('http', 'strategy', { strategy: 'nothing_supplies_this' })))
      .not.toThrow();
  });

  test('still asks for the secret the handshake starts from', () => {
    // `ensureStaticCredential` throws for any credential that is asked for and
    // finds no per-connection prompt, and a strategy is asked for.
    const prompts = deriveManifest(answers('http', 'strategy')).setup?.prompts ?? [];

    expect(prompts.map((p) => [p.key, p.secret, p.scope])).toEqual([['api_key', true, 'connection']]);
  });

  test('and it only works over a connector that makes a request to sign', () => {
    for (const connector of ['mcp', 'imap', 'dav', 'fs'] as const) {
      expect(() => deriveManifest(answers(connector, 'strategy'))).toThrow();
    }
  });

  test('an option that is not one says what one looks like', () => {
    expect(() =>
      deriveManifest(answers('http', 'strategy', { 'strategy-option': ['nonsense'] })),
    ).toThrow(/Write it as "key=value"/);
  });

  /**
   * That a manifest this command writes actually reaches the code it names.
   *
   * Deriving `auth: { kind: strategy, strategy: x }` is worth nothing if the
   * declaration-only path cannot resolve `x` — and that path exists precisely
   * for a workspace YAML, which has no `ProviderDefinition` of its own. Asserted
   * against the real `strategyFor` and a real registry rather than against the
   * shape of the auth block.
   */
  test('and the manifest reaches a strategy a built-in supplies', () => {
    const registry = buildRegistry();
    const supplied = registry
      .list()
      .map((entry) => entry.definition?.authStrategy?.id)
      .find((id): id is string => typeof id === 'string');

    // If nothing in this build carries one, there is nothing to borrow and the
    // rest of this test would assert its own premise.
    expect(supplied).toBeString();

    const manifest = deriveManifest(answers('http', 'strategy', { strategy: supplied! }));

    expect(strategyFor(manifest, registry).id).toBe(supplied!);
  });

  test('while a name nothing supplies is refused by the registry, not by the schema', () => {
    const manifest = deriveManifest(answers('http', 'strategy', { strategy: 'nothing_supplies_this' }));

    expect(() => strategyFor(manifest, buildRegistry())).toThrow(/not registered/);
  });
});

describe('an OAuth client the manifest promises and cannot present', () => {
  test('half a pair of endpoints is refused, either half', () => {
    for (const half of ['authorize-url', 'token-url'] as const) {
      expect(() =>
        deriveManifest(answers('mcp', 'oauth', { [half]: 'https://auth.example.com/x' })),
      ).toThrow(/declared together or not at all/);
    }
  });

  test('a REST API cannot register a client dynamically', () => {
    expect(() =>
      deriveManifest(answers('http', 'oauth', { ...endpoints, registration: 'dynamic' })),
    ).toThrow(/publishes no registration endpoint/);
  });

  test('a REST API with no endpoints has nowhere to send the browser', () => {
    // Refused before the write. Left alone this reaches `authoriseDirect`, which
    // needs both URLs, after the operator has already answered two prompts.
    expect(() => deriveManifest(answers('http', 'oauth'))).toThrow(/no metadata document/);
  });

  test('declaring endpoints on an mcp connector takes it off the SDK path, so it needs a client', () => {
    expect(() =>
      deriveManifest(answers('mcp', 'oauth', { ...endpoints, registration: 'dynamic' })),
    ).toThrow(/ADR-040/);
  });

  test('mcp defaults to dynamic, and everything else to manual', () => {
    expect(deriveManifest(answers('mcp', 'oauth')).auth).toMatchObject({
      kind: 'oauth',
      registration: 'dynamic',
    });
    expect(deriveManifest(answers('http', 'oauth', endpoints)).auth).toMatchObject({
      registration: 'manual',
      app: 'thing',
    });
  });

  test('naming an app is enough to mean "my own client", even on mcp', () => {
    const manifest = deriveManifest(answers('mcp', 'oauth', { 'client-app': 'shared' }));
    expect(manifest.auth).toMatchObject({ registration: 'manual', app: 'shared' });
  });
});

describe('a credential flag that would be dropped in silence', () => {
  test('an mcp bearer token cannot be renamed', () => {
    expect(() => deriveManifest(answers('mcp', 'bearer', { 'auth-header': 'X-Token' }))).toThrow(
      /could not be honoured/,
    );
  });

  test('a header credential has no query form', () => {
    expect(() =>
      deriveManifest(answers('http', 'header', { 'auth-query': 'key' })),
    ).toThrow(/only meaningful for --auth api-key/);
  });

  test('an api key goes in one place or the other, never both', () => {
    expect(() =>
      deriveManifest(answers('http', 'api-key', { 'auth-header': 'X-Key', 'auth-query': 'key' })),
    ).toThrow(/contradict/);
  });

  test('an identity URL with no field to read is refused', () => {
    expect(() =>
      deriveManifest(answers('http', 'bearer', { 'identity-url': 'https://api.example.com/me' })),
    ).toThrow(/needs --identity-field/);
  });
});

describe('what the manifest carries without being asked', () => {
  test('a protocol that knows the account is told to say so', () => {
    for (const connector of ['imap', 'dav', 'fs'] as const) {
      const auth = connector === 'fs' ? 'none' : 'basic';
      expect(deriveManifest(answers(connector, auth)).identity).toEqual({ kind: 'connector' });
    }
  });

  test('and one that would have to guess a tool name is not', () => {
    expect(deriveManifest(answers('mcp', 'bearer')).identity).toBeUndefined();
  });

  test('basic auth gets exactly one username and one password, in that order', () => {
    // `defineProvider` requires exactly one of each, and the store holds them as
    // `username:password`. Asserted for every connector that can use it.
    for (const connector of ['http', 'imap', 'dav'] as const) {
      const prompts = deriveManifest(answers(connector, 'basic')).setup?.prompts ?? [];
      expect(prompts.map((p) => [p.key, p.field])).toEqual([
        ['username', 'username'],
        ['password', 'password'],
      ]);
    }
  });

  test('a secret is marked as one, so nothing echoes it', () => {
    const prompts = deriveManifest(answers('http', 'bearer')).setup?.prompts ?? [];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ key: 'token', secret: true, scope: 'connection' });
  });

  test('dynamic registration asks for nothing at all', () => {
    expect(deriveManifest(answers('mcp', 'oauth')).setup).toBeUndefined();
  });

  test('a sentence becomes a step and a URL becomes a link, never setup.docs', () => {
    // `setup.docs` is read by nothing — `printSetup` renders `summary`,
    // `docs_url` and `steps`. A manifest using it validates and shows nothing.
    const sentence = deriveManifest(answers('http', 'bearer', { 'setup-docs': 'Ask your admin.' }));
    expect(sentence.setup).toMatchObject({ steps: ['Ask your admin.'] });
    expect(sentence.setup).not.toHaveProperty('docs');

    const url = deriveManifest(
      answers('http', 'bearer', { 'setup-docs': 'https://example.com/tokens' }),
    );
    expect(url.setup).toMatchObject({ docs_url: 'https://example.com/tokens' });
    expect(url.setup?.steps).toEqual([]);
  });

  test('an OAuth walkthrough warns about the loopback redirect, which nobody guesses', () => {
    const manifest = deriveManifest(
      answers('http', 'oauth', { ...endpoints, 'setup-docs': 'https://example.com/apps' }),
    );

    expect(manifest.setup?.steps.join(' ')).toMatch(/port chosen per run/);
  });

  test('and names the flag for a vendor that matches the whole redirect URL', () => {
    // `connect` listens on a port the kernel picks. A server that pins the URL
    // refuses with `redirect_uri_mismatch`, which says nothing about what to do.
    const manifest = deriveManifest(
      answers('http', 'oauth', { ...endpoints, 'setup-docs': 'https://example.com/apps' }),
    );

    expect(manifest.setup?.steps.join(' ')).toMatch(/--redirect-uri/);
  });

  test('extra authorization parameters are passed through', () => {
    // The difference between a connection that refreshes and one that works for
    // an hour: Google needs `access_type=offline`, and nothing but a vendor's own
    // docs says whether they do too.
    const manifest = deriveManifest(
      answers('http', 'oauth', {
        ...endpoints,
        'authorize-param': ['access_type=offline', 'prompt=consent'],
      }),
    );

    expect(manifest.auth).toMatchObject({
      authorize_params: { access_type: 'offline', prompt: 'consent' },
    });
  });

  test('and one that is not a parameter names the flag it came from', () => {
    expect(() =>
      deriveManifest(answers('http', 'oauth', { ...endpoints, 'authorize-param': ['nope'] })),
    ).toThrow(/--authorize-param "nope"/);
  });

  test('a fixed redirect is written when it is given', () => {
    const manifest = deriveManifest(
      answers('http', 'oauth', { ...endpoints, 'redirect-uri': 'http://127.0.0.1:8765/callback' }),
    );

    expect(manifest.auth).toMatchObject({ redirect_uri: 'http://127.0.0.1:8765/callback' });
  });
});

describe('headers the vendor requires of a client', () => {
  test('are written for the two connectors that have the field', () => {
    for (const connector of ['mcp', 'http'] as const) {
      const manifest = deriveManifest(
        answers(connector, 'none', { header: ['User-Agent: thing:1.0 (by someone)'] }),
      );

      expect(manifest.connector).toMatchObject({
        headers: { 'User-Agent': 'thing:1.0 (by someone)' },
      });
    }
  });

  test('a value with a colon in it survives, because only the first one separates', () => {
    const manifest = deriveManifest(
      answers('http', 'none', { header: ['X-Trace: a:b:c'] }),
    );

    expect(manifest.connector).toMatchObject({ headers: { 'X-Trace': 'a:b:c' } });
  });

  test('Authorization is refused here, where somebody is choosing', () => {
    // `defineProvider` refuses it too, with the rule. This one says what to use.
    expect(() =>
      deriveManifest(answers('http', 'none', { header: ['Authorization: Bearer nope'] })),
    ).toThrow(/--auth bearer/);
  });

  test('something that is not a header says what one looks like', () => {
    expect(() => deriveManifest(answers('http', 'none', { header: ['nonsense'] }))).toThrow(
      /Write it as "Name: value"/,
    );
  });
});

describe('a default is followed, not frozen into the file', () => {
  test('an unstated port is absent, so a later default reaches this manifest', () => {
    const connector = deriveDeclaration(answers('imap', 'basic'))['connector'];
    expect(connector).not.toHaveProperty('port');
    expect(connector).not.toHaveProperty('smtp');
  });

  test('no SMTP host means a read-only mailbox by construction', () => {
    // `imap/index.ts` reads the absence of the block, so this is what makes a
    // mailbox unable to send rather than merely ungranted.
    const withSmtp = deriveDeclaration(answers('imap', 'basic', { 'smtp-host': 'smtp.example.com' }));
    expect(withSmtp['connector']).toHaveProperty('smtp');
  });

  test('starttls follows the port it was given', () => {
    const implicit = deriveManifest(
      answers('imap', 'basic', { 'smtp-host': 'smtp.example.com', 'smtp-port': '465' }),
    ).connector as { smtp: { starttls: boolean } };
    const upgraded = deriveManifest(
      answers('imap', 'basic', { 'smtp-host': 'smtp.example.com', 'smtp-port': '587' }),
    ).connector as { smtp: { starttls: boolean } };

    expect(implicit.smtp.starttls).toBe(false);
    expect(upgraded.smtp.starttls).toBe(true);
  });

  test('a port that is not one is refused with the flag named', () => {
    expect(() => deriveManifest(answers('imap', 'basic', { port: '99999' }))).toThrow(/--port/);
    expect(() => deriveManifest(answers('imap', 'basic', { port: 'imap' }))).toThrow(/--port/);
  });

  test('operation filters are written only when asked for', () => {
    expect(deriveDeclaration(answers('http', 'none'))['connector']).not.toHaveProperty('operations');
    expect(
      deriveDeclaration(answers('http', 'none', { operations: ['*Account*'] }))['connector'],
    ).toMatchObject({ operations: { include: ['*Account*'] } });
  });
});

describe('the written file', () => {
  test('is byte-identical for the same answers', () => {
    // A re-run compares parsed manifests, not bytes — but a writer that is not
    // deterministic makes every other guarantee here harder to reason about.
    const first = renderManifest(deriveDeclaration(answers('http', 'bearer')));
    const second = renderManifest(deriveDeclaration(answers('http', 'bearer')));

    expect(first).toBe(second);
  });

  test('says whose file it is now', () => {
    expect(renderManifest(deriveDeclaration(answers('http', 'bearer')))).toMatch(/Yours to edit/);
  });
});
