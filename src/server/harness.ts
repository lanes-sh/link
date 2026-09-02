import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  AuthenticatorChain,
  BearerAuthenticator,
  IssuedTokenAuthenticator,
  OAuthServer,
  OAuthStore,
  type Federation,
} from '#auth';
import { oneProfile, type ProfileRuntime } from './mcp/index.ts';
import {
  type ConnectionConfig, parseConfig, type Config } from '#profile';
import { ProviderRegistry, toPolicyDocument } from '#registry';
import { Dispatcher } from '#dispatch';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { RateLimiter } from '#policy';
import { silentLogger, type Logger } from './logging.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { exampleProvider } from '#providers/example/provider.ts';
import { createLocalConnector } from '#connectivity/transports';
import type { RuntimeState } from '#stores/state';
import type { AuditStore } from '#audit';
import { createBlobAuditStore } from '#deployments/adapters/audit-blob.ts';
import type { AnyConnector, ProviderDefinition } from '#connectivity';
import { serve, type RunningServer } from './index.ts';
import { Generations } from './generations.ts';
import { serveOverStdio } from './stdio.ts';

/**
 * Test harness: a fully wired profile served over real HTTP on a real port.
 *
 * Deliberately not a mock of the transport. The point of these tests is that
 * an agent talking to the actual endpoint sees the right tools and is refused
 * the right calls, and a mocked transport cannot demonstrate that.
 */

/**
 * The connections a harness config implies, derived from its grants.
 *
 * A test config declares grants and no `connections.yaml` — there is no
 * workspace on disk to read one from. Deriving the rows from the grant refs
 * keeps the harness honest about the only thing dispatch uses them for, which is
 * resolving `<provider>.<id>` to a provider and an id. Anything richer (an
 * account label, a credential ref) belongs to a real workspace and a test that
 * needs one builds it.
 */
function harnessConnections(config: Config): ConnectionConfig[] {
  return config.grants.map((grant) => {
    const [provider = '', id = ''] = grant.connection.split('.');
    return { provider, id, account: grant.connection };
  });
}

export const TEST_TOKEN = 'llk_test_token_value';

/**
 * The subject the harness's one token row is issued to.
 *
 * A real subject shape rather than a placeholder, because `subjectRef` validates
 * it wherever a config carries one — and the harness's `profilesFor` returns
 * every wired profile for it, which is what the static token used to reach by
 * having no list at all.
 */
export const HARNESS_SUBJECT = 'lanes:harness0000';

/** A signed-in person no profile lists. See the federation stub below. */
export const STRANGER = 'NOBODY_LISTS_THIS_PERSON';

/**
 * A profile for the harness, from the `allow`/`deny` a test hands over.
 *
 * The two `example` accounts are the point: every test here is about a rule
 * covering both, or one of them, so the harness gives each its own grant row
 * carrying the same rules (ADR-058). That is what the flat block used to mean,
 * which keeps every existing test asserting what it was written to assert.
 */
export function configFor(profile: string, port: number, policy: string): Config {
  const rules = policy
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `    ${line.trim()}`)
    .join('\n');

  const grant = (id: string): string =>
    `  - connection: example.${id}\n${rules.replace(/^ {4}(allow|deny):/gm, '    $1:')}`;

  return parseConfig(`
contract: 5
instance:
  profile: ${profile}
  port: ${port}
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
grants:
${grant('a')}
${grant('b')}
members: []
`).config;
}

export interface Harness {
  readonly server: RunningServer;
  readonly state: RuntimeState;
  readonly audit: AuditStore;
  readonly token: string;
  /**
   * The primary profile's dispatcher.
   *
   * Exposed because policy denial and MCP discovery filtering are two different
   * observations of one decision, and only one of them is visible over the
   * wire: a capability a profile cannot reach is never registered, so calling
   * it is answered by the SDK before any of our code runs. Asserting that the
   * *denial* is recorded means asking the layer that records it.
   */
  readonly dispatcher: Dispatcher;
  /** The generation holder, so a test can drive a reload without an HTTP call. */
  readonly generations: Generations;
  stop(): Promise<void>;
}

export { parseConfig } from '#profile';

export interface HarnessOptions {
  profile: string;
  log?: Logger;
  /**
   * The clock the authorization server and its store share.
   *
   * Shared deliberately: a tombstone's `consumedAt` is written by the store and
   * compared by the server, so two clocks would make the reuse interval
   * untestable in the one direction that matters. Absent means `Date.now`.
   */
  now?: () => number;
  port: number;
  policy: string;
  token?: string;
  /** Extra providers to register beyond `example`. */
  providers?: readonly ProviderDefinition[];
  /** Credentials to seed, beyond the profile token. */
  credentials?: Record<string, string>;
  /** Overrides the generated config wholesale, for providers needing more than the default. */
  config?: Config;
  /** Extra profiles this one endpoint also serves, each with its own policy. */
  alsoServe?: ReadonlyArray<{ profile: string; policy: string }>;
  /**
   * What the endpoint calls to re-read skills before serving a request.
   *
   * Handed the registry so a test can swap the skills provider in it, which is
   * what `openRuntime` does for real. Passed in rather than built here because
   * where skills are stored is the runtime's business, not the transport's.
   */
  refreshSkills?: (registry: ProviderRegistry) => Promise<void>;
  /** Serve the `self` authorization flow alongside the bearer token. */
  authorization?: boolean;
  /**
   * The identity half of that flow, stubbed.
   *
   * The real one talks to lanes.sh and verifies a signature; a test that
   * exercised it would be testing `AssertionVerifier`, which has its own file
   * and its own key pair. What a harness test is about is what the endpoint
   * does *with* an answer, so the answer is injected.
   */
  federation?: Partial<Federation>;
  /**
   * What a reload re-reads, standing in for `openReconciled` over a workspace
   * this harness does not have. Throwing is how the "a failed reload keeps
   * serving the old generation" case is reached; absent means nothing new.
   */
  reopen?: () => Promise<ReadonlyMap<string, ProfileRuntime>>;
  /**
   * Meter the pre-authentication surface, as a routable deployment does.
   *
   * A harness binds loopback, where `serve()` leaves this off — the ceiling
   * protects a credential-store call over the network and an object written to a
   * bucket, and on loopback both are a local file. Set it to drive the deployed
   * behaviour without a deployment.
   */
  meterUnauthenticated?: boolean;
}

/**
 * Everything a transport needs, wired from one set of options.
 *
 * Extracted when stdio arrived: the two transports differ in how a caller
 * reaches the profiles, and in nothing else. A second copy of this wiring would
 * have let them drift, which is exactly what the stdio tests are for.
 */
interface WiredProfiles {
  readonly profiles: Map<string, ProfileRuntime>;
  readonly state: RuntimeState;
  /** The real blob-backed log over an in-memory store, not a second fake. */
  readonly audit: AuditStore;
  readonly dispatcher: Dispatcher;
  readonly credentials: ReturnType<typeof createMemoryCredentials>;
  readonly token: string;
}

export function wireProfiles(options: HarnessOptions): WiredProfiles {
  const config = options.config ?? configFor(options.profile, options.port, options.policy);
  const token = options.token ?? TEST_TOKEN;

  const state = createMemoryState();
  const audit = createBlobAuditStore({ storage: createMemoryBlobStore() });
  // `tokens/tok1`, matching the row `startHarness` declares below. The old key
  // was `profile/token`, the constant ADR-068 removed.
  const credentials = createMemoryCredentials({ 'tokens/tok1': token, ...options.credentials });
  // `allowReserved` for the same reason `buildRegistry` passes it: the owner
  // layer claims `memory`, `skills`, and `vault`, and the guard still refuses
  // them everywhere else.
  const registry = new ProviderRegistry({ allowReserved: true });
  registry.register(exampleProvider);
  for (const provider of options.providers ?? []) registry.register(provider);

  const policy = toPolicyDocument(config);

  const dispatcher = new Dispatcher({
    config,
    connections: harnessConnections(config),
    oauthApps: [],
    registry,
    connectorFor: (providerId): AnyConnector | undefined => {
      const entry = registry.get(providerId);
      return entry?.definition ? createLocalConnector(entry.definition) : undefined;
    },
    policy,
    state,
    audit,
    credentials,
    storage: createMemoryBlobStore(),
    limiter: new RateLimiter(),
    log: silentLogger(),
  });

  // Each extra profile gets its own state and its own log, so the isolation
  // the tests assert is real rather than a naming convention.
  const profiles = new Map(
    oneProfile(options.profile, {
      config,
      registry,
      dispatcher,
      policy,
      ...(options.refreshSkills ? { refreshSkills: () => options.refreshSkills!(registry) } : {}),
    }),
  );

  for (const extra of options.alsoServe ?? []) {
    const extraConfig = configFor(extra.profile, options.port, extra.policy);
    const extraPolicy = toPolicyDocument(extraConfig);
    const extraDatabase = createMemoryState();

    profiles.set(extra.profile, {
      config: extraConfig,
      registry,
      policy: extraPolicy,
      dispatcher: new Dispatcher({
        config: extraConfig,
        connections: harnessConnections(extraConfig),
        oauthApps: [],
        registry,
        connectorFor: (providerId): AnyConnector | undefined => {
          const entry = registry.get(providerId);
          return entry?.definition ? createLocalConnector(entry.definition) : undefined;
        },
        policy: extraPolicy,
        state: extraDatabase,
        audit: createBlobAuditStore({ storage: createMemoryBlobStore() }),
        credentials,
        storage: createMemoryBlobStore(),
        limiter: new RateLimiter(),
        log: silentLogger(),
      }),
    });
  }

  return { profiles, state, audit, dispatcher, credentials, token };
}

export function startHarness(options: HarnessOptions): Harness {
  const { profiles, state, audit, dispatcher, credentials, token } = wireProfiles(options);

  // One row, bound to a subject the harness's profiles list, so the static
  // token resolves the way it does in production (ADR-068) rather than through
  // a special case that would stop the tests covering the real path.
  const bearer = new BearerAuthenticator({
    profile: options.profile,
    tokens: async () => [{ id: 'tok1', subject: HARNESS_SUBJECT, ref: 'tokens/tok1' }],
    credentials,
    profilesFor: async () => [...profiles.keys()],
  });

  // The real wiring from `endpoint.ts`, not a stand-in: the flow under test is
  // the one a connector drives over HTTP, and a fake authorization server would
  // demonstrate that the fake works.
  const log = options.log ?? silentLogger();

  const store = options.authorization ? new OAuthStore(state.kv, options.now) : null;
  const gate = store
    ? {
        surface: {
          server: new OAuthServer({
            store,
            accessTokenTtlMs: 3_600_000,
            log,
            ...(options.now ? { now: options.now } : {}),
            federation: {
              consentUrl: 'https://lanes.example/link/authorize',
              // Anything non-empty verifies, as the subject it spells. Enough to
              // drive the flow, and obviously not a verifier.
              verify: async (assertion) =>
                assertion ? { subject: `lanes:${assertion}`, email: null } : null,
              // One reserved spelling answers "no profile names them", because
              // that refusal is a real branch — a person signs in successfully
              // and still reaches nothing — and there has to be a way to drive it.
              profilesFor: async (subject) =>
                subject === `lanes:${STRANGER}` ? [] : [options.profile],
              ...options.federation,
            },
          }),
          issuer: (origin: string) => origin,
          mcpPath: '/mcp',
          target: 'local',
        },
        authenticator: new IssuedTokenAuthenticator(store, options.profile),
      }
    : null;

  const nothing = () => Promise.resolve();
  const generations = new Generations(
    { profiles, close: nothing },
    async () => ({ profiles: (await options.reopen?.()) ?? profiles, close: nothing }),
    { primary: options.profile, log },
  );

  const server = serve({
    generations,
    primary: options.profile,
    authenticator: gate ? new AuthenticatorChain([bearer, gate.authenticator]) : bearer,
    ...(gate ? { authorization: gate.surface } : {}),
    ...(options.meterUnauthenticated ? { meterUnauthenticated: true } : {}),
    log,
  });

  // As `startEndpoint` does, and after `serve()` for the same reason: the
  // record means the socket is bound. Here because this harness claims to be
  // the real wiring, and a boot step it omits is a boot step no test can see.
  generations.announce();

  return {
    server,
    state,
    audit,
    token,
    dispatcher,
    generations,
    stop: () => server.stop(),
  };
}

export interface StdioHarness {
  /** A real MCP client, connected to the real surface over a linked transport pair. */
  readonly client: Client;
  readonly state: RuntimeState;
  readonly audit: AuditStore;
  readonly dispatcher: Dispatcher;
  stop(): Promise<void>;
}

/**
 * The same profiles, served over stdio instead of a port.
 *
 * `InMemoryTransport.createLinkedPair()` stands in for the pipe: the surface
 * gets one end, a real `Client` gets the other, and nothing about the surface
 * knows the difference — `serveOverStdio` takes the transport for exactly this
 * reason. What is not exercised is the process boundary itself, which is the
 * client's business rather than ours.
 */
export async function startStdioHarness(
  options: HarnessOptions & { clientLabel?: string },
): Promise<StdioHarness> {
  const { profiles, state, audit, dispatcher } = wireProfiles(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  const surface = serveOverStdio({
    profiles,
    primary: options.profile,
    log: silentLogger(),
    transport: serverSide,
    ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
  });

  const client = new Client({ name: options.clientLabel ?? 'lanes-link-stdio-test', version: '0.0.0' });
  await client.connect(clientSide);

  return {
    client,
    state,
    audit,
    dispatcher,
    async stop() {
      await client.close();
      await surface.close();
    },
  };
}

export interface RpcResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * One JSON-RPC call over the wire.
 *
 * Handles both plain JSON and SSE-framed responses, because a streamable HTTP
 * server may answer either and a test that only understands one would fail for
 * the wrong reason.
 */
export async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  options: { token?: string | null; clientLabel?: string; id?: number } = {},
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    // 2026-07-28 requires the method — and, where the payload names one, the
    // target — in headers as well as in the body, so an intermediary can route
    // without parsing the payload. The server rejects the request if the two
    // disagree, which is what makes the header trustworthy.
    'mcp-method': method,
  };
  // 2026-07-28 mirrors `params.name` for `tools/call` and `prompts/get`, and
  // `params.uri` for `resources/read`, into `Mcp-Name`. The server rejects the
  // request when the two disagree — including when the header is simply absent
  // — so a resource test that only mirrored `name` would fail for the wrong
  // reason.
  const named = params['name'] ?? params['uri'];
  if (typeof named === 'string') headers['mcp-name'] = named;
  if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? TEST_TOKEN}`;
  if (options.clientLabel) headers['x-mcp-client'] = options.clientLabel;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: {
        ...params,
        // The 2026-07-28 envelope: every request declares its protocol
        // version and the caller's capabilities, since there is no
        // handshake left to establish them once.
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: options.clientLabel ?? 'lanes-link-test',
            version: '0.0.0',
          },
        },
      },
    }),
  });

  const text = await response.text();
  return { status: response.status, body: parseBody(text) };
}

function parseBody(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};

  if (text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')) {
    const line = text
      .split('\n')
      .find((candidate) => candidate.startsWith('data:'));
    return line ? (JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>) : {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/** Port allocator, so parallel test files never collide. */
let nextPort = 7900;
export function allocatePort(): number {
  return nextPort++;
}
