import { afterAll, describe, expect, test } from 'bun:test';
import { parseConfig } from '#profile';
import { defineProvider } from '#connectivity';
import { createSetupProvider } from '#providers/owner.ts';
import { allocatePort, rpc, startHarness } from './harness.ts';

/**
 * The read-only setup surface, end to end over real HTTP.
 *
 * The assertion that matters is the oracle one. ADR-007 says probing must not be
 * an oracle: an unknown capability and a denied one are refused identically, so
 * a caller cannot map what it is not allowed to have. A surface that *describes*
 * what is set up could undo that in one call by reporting a connection policy
 * hides — so a denied provider has to read exactly like a provider nobody ever
 * connected, character for character.
 */

const CATALOGUE = [
  defineProvider({
    id: 'example',
    name: 'Example',
    version: '1.0.0',
    description: 'a local reference provider',
    connector: { kind: 'local' },
    auth: { kind: 'none' },
  }),
  defineProvider({
    id: 'thing',
    name: 'Thing',
    version: '1.0.0',
    description: 'a provider nobody here has connected',
    connector: { kind: 'http', base_url: 'https://example.test', openapi: './x.json' },
    auth: { kind: 'header', header: 'X-Key' },
    setup: {
      steps: ['Make a key'],
      prompts: [
        { key: 'key', label: 'API key', secret: true, scope: 'connection', field: 'value' },
      ],
    },
  }),
];

function config(profile: string, port: number, policy: string) {
  return parseConfig(`
contract: 1
instance:
  profile: ${profile}
  default_target: local
  port: ${port}
targets:
  local:
    credentials: { adapter: file, path: ./data/${profile}.credentials.enc }
    storage: { adapter: filesystem, path: ./data/${profile}/files }
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
connections:
  - id: main
    provider: setup
    account: Setup
  - id: a
    provider: example
    account: someone@example.test
policy:
${policy}
`).config;
}

/**
 * `reachable` as `open.ts` builds it — filtered by the same policy the
 * dispatcher enforces with, which is the whole point of it being one function.
 */
function providersFor(profile: string, granted: readonly string[]) {
  // `example` is registered by the harness itself, as it is for every test here.
  return [
    createSetupProvider({
      profile,
      target: 'local',
      catalogue: CATALOGUE,
      reachable: () =>
        granted.includes('example')
          ? [{ key: 'example.a', provider: 'example', account: 'someone@example.test' }]
          : [],
    }),
  ];
}

const grantedPort = allocatePort();
const deniedPort = allocatePort();
const neverPort = allocatePort();
const noSetupPort = allocatePort();

/** Setup and the example account both reachable. */
const granted = startHarness({
  profile: 'granted',
  port: grantedPort,
  policy: '',
  providers: providersFor('granted', ['example']),
  config: config('granted', grantedPort, `  allow:\n    - "setup.*"\n    - "example.*"`),
});

/** The example account is configured, and policy hides it. */
const denied = startHarness({
  profile: 'denied',
  port: deniedPort,
  policy: '',
  token: 'llk_denied_token_value',
  providers: providersFor('denied', []),
  config: config(
    'denied',
    deniedPort,
    `  allow:\n    - "setup.*"\n    - "example.*"\n  deny:\n    - "example.*"`,
  ),
});

/** Nothing but setup was ever connected. */
const never = startHarness({
  profile: 'never',
  port: neverPort,
  policy: '',
  token: 'llk_never_token_value',
  providers: providersFor('never', []),
  config: parseConfig(`
contract: 1
instance:
  profile: never
  default_target: local
  port: ${neverPort}
targets:
  local:
    credentials: { adapter: file, path: ./data/never.credentials.enc }
    storage: { adapter: filesystem, path: ./data/never/files }
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
connections:
  - id: main
    provider: setup
    account: Setup
policy:
  allow:
    - "setup.*"
`).config,
});

/** The surface itself denied. */
const noSetup = startHarness({
  profile: 'nosetup',
  port: noSetupPort,
  policy: '',
  token: 'llk_nosetup_token_value',
  providers: providersFor('nosetup', ['example']),
  config: config('nosetup', noSetupPort, `  allow:\n    - "example.*"`),
});

afterAll(async () => {
  await Promise.all([granted.stop(), denied.stop(), never.stop(), noSetup.stop()]);
});

async function listTools(url: string, token?: string): Promise<string[]> {
  const response = await rpc(url, 'tools/list', {}, token ? { token } : {});
  const result = response.body['result'] as { tools?: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name).sort();
}

async function call(
  url: string,
  name: string,
  args: Record<string, unknown>,
  profile: string,
  token?: string,
): Promise<{ text: string; isError: boolean }> {
  const response = await rpc(
    url,
    'tools/call',
    { name, arguments: { profile, connection: 'setup.main', ...args } },
    token ? { token } : {},
  );
  const result = response.body['result'] as
    | { content?: { text?: string }[]; isError?: boolean }
    | undefined;

  return {
    text: (result?.content ?? []).map((block) => block.text ?? '').join('\n'),
    isError: result?.isError === true,
  };
}

describe('registration follows policy like anything else', () => {
  test('both capabilities are advertised when setup.* is allowed', async () => {
    const names = await listTools(granted.server.url);

    expect(names).toContain('setup_overview');
    expect(names).toContain('setup_provider');
  });

  test('neither is advertised when it is not', async () => {
    const names = await listTools(noSetup.server.url, 'llk_nosetup_token_value');

    // Not merely refused on call — absent, which is what default-deny means
    // everywhere else in this codebase.
    expect(names).not.toContain('setup_overview');
    expect(names).not.toContain('setup_provider');
  });
});

describe('what a caller is told about connections', () => {
  test('a reachable account is named, label and all', async () => {
    const { text } = await call(granted.server.url, 'setup_overview', {}, 'granted');

    expect(text).toContain('example.a');
    expect(text).toContain('someone@example.test');
  });

  test('a denied connection reads exactly like one that never existed', async () => {
    const hidden = await call(
      denied.server.url,
      'setup_overview',
      {},
      'denied',
      'llk_denied_token_value',
    );
    const absent = await call(
      never.server.url,
      'setup_overview',
      {},
      'never',
      'llk_never_token_value',
    );

    // Profile names differ; everything about what is reachable must not.
    const normalise = (text: string) => text.replace(/"(denied|never)"/g, '"<profile>"');

    expect(normalise(hidden.text)).toBe(normalise(absent.text));
    expect(hidden.text).not.toContain('someone@example.test');
    expect(hidden.text).not.toContain('example.a');
  });

  test('the account label never leaks through the provider detail either', async () => {
    const { text } = await call(
      denied.server.url,
      'setup_provider',
      { id: 'example' },
      'denied',
      'llk_denied_token_value',
    );

    expect(text).not.toContain('someone@example.test');
    expect(text).not.toContain('Already connected');
  });
});

describe('what a caller is handed to run', () => {
  test('the command names the profile it was asked about', async () => {
    const { text } = await call(granted.server.url, 'setup_provider', { id: 'thing' }, 'granted');

    expect(text).toContain('lanes link connect thing --profile granted');
  });

  test('it discloses no filesystem path', async () => {
    const { text } = await call(granted.server.url, 'setup_overview', {}, 'granted');

    expect(text).not.toContain('/');
  });

  test('an unknown provider is an error result rather than a dropped connection', async () => {
    const { text, isError } = await call(
      granted.server.url,
      'setup_provider',
      { id: 'nope' },
      'granted',
    );

    expect(isError).toBe(true);
    expect(text).toContain('setup_overview');
  });
});
