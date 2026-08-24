/**
 * Talking to a service that holds an OAuth client secret this machine cannot.
 *
 * Three requests, one shape each, and no knowledge of whose client is on the
 * other end — the URL arrives as declared manifest data. Both callers live in
 * different components (the CLI performs the first exchange, the dispatcher
 * refreshes while serving), and putting the wire format here is what stops the
 * two drifting into disagreeing about it.
 *
 * Everything here is a plain `fetch` against an operator-declared origin. There
 * is deliberately no retry: a broker that is down should surface as a refusal
 * the operator can read, not as a command that hangs.
 */

/**
 * Stamped on a credential this broker issued, and read back at refresh.
 *
 * The one fact the refresh path cannot derive: which client minted the token it
 * is holding. Config cannot answer it, because config can change afterwards.
 */
export const BROKERED = 'broker';

/** What the broker will authorise, and whether it is currently doing so. */
export interface BrokerConfig {
  readonly clientId: string;
  /** Every scope the client is registered for. Empty means "unstated". */
  readonly scopesSupported: readonly string[];
  /** Added to every request so the exchange returns an identity assertion. */
  readonly identityScopes: readonly string[];
  readonly open: boolean;
  /** Why it is closed, or near capacity. The broker's words, printed verbatim. */
  readonly notice: string | undefined;
  readonly docsUrl: string | undefined;
  /** How full the shared client is, when the broker says. Advisory. */
  readonly capacity: { readonly accounts: number; readonly cap: number } | undefined;
}

/** A token response, in the vendor's own field names. */
export interface BrokerTokens {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
}

/**
 * A refusal, carrying what the caller needs to explain it.
 *
 * `ownClient` is the broker saying "registering a client of your own is the way
 * past this". It matters because the two failures look identical otherwise: a
 * shared client at capacity and a replayed authorization code are both a 4xx,
 * and only one of them is solved by an hour in a cloud console.
 */
export class BrokerError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly notice: string | undefined;
  readonly ownClient: boolean;
  readonly docsUrl: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    fields: {
      status: number;
      code?: string | undefined;
      notice?: string | undefined;
      ownClient?: boolean | undefined;
      docsUrl?: string | undefined;
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(message);
    this.name = 'BrokerError';
    this.status = fields.status;
    this.code = fields.code;
    this.notice = fields.notice;
    this.ownClient = fields.ownClient === true;
    this.docsUrl = fields.docsUrl;
    this.retryAfterSeconds = fields.retryAfterSeconds;
  }
}

type Fetch = typeof globalThis.fetch;

export const BROKER_ORIGIN_ENV = 'LANES_LINK_BROKER_ORIGIN';

/** Loopback, in the spellings a `URL` will hand back for one. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Aiming the exchange somewhere other than the origin the manifest declares.
 *
 * A broker running on this machine and a staging deployment are the same
 * problem: everything about the flow is unchanged except which host holds the
 * secret. An origin is the whole of the difference, so a provider keeps its own
 * path and only the origin in front of it moves.
 *
 * It refuses rather than falls back, because the failure it would otherwise
 * cause is the expensive kind — believing you are exercising a local broker
 * while a real authorization code goes to production. A variable that is
 * ignored when malformed is worse than one that stops the command.
 *
 * `http` is confined to loopback for the same reason the redirect is: off this
 * machine it puts an authorization code on the wire in the clear.
 */
export function brokerOriginOverride(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  const raw = env[BROKER_ORIGIN_ENV]?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${BROKER_ORIGIN_ENV} is not a URL: ${raw}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // `localhost:8080` is the mistake people make, and it *parses* — as a URL
    // whose scheme is "localhost". Saying which scheme it read is what turns
    // that from a baffling refusal into an obvious missing `http://`.
    throw new Error(
      `${BROKER_ORIGIN_ENV} must be an http or https URL. "${raw}" reads as scheme ` +
        `"${url.protocol.replace(':', '')}" — a host and port with no scheme becomes one.`,
    );
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Error(
      `${BROKER_ORIGIN_ENV} may only be http for a loopback host. "${url.hostname}" over http ` +
        `would put the authorization code on the wire in the clear — use https.`,
    );
  }
  return url.origin;
}

/** The `{success, data}` envelope, unwrapped, or thrown as a `BrokerError`. */
async function unwrap(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A proxy or a captive portal answering in HTML is a real failure mode, and
    // "Unexpected token <" tells the operator nothing about what went wrong.
    if (response.ok) {
      throw new BrokerError(`${what} returned a response that was not JSON.`, {
        status: response.status,
      });
    }
  }

  if (!response.ok || body['success'] === false) {
    const retry = Number(response.headers.get('retry-after'));
    throw new BrokerError(str(body['error']) ?? `${what} failed (${response.status}).`, {
      status: response.status,
      code: str(body['code']),
      notice: str(body['notice']),
      ownClient: body['own_client'] === true,
      docsUrl: str(body['docs_url']),
      retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
  }

  const data = body['data'];
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : body;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

async function post(
  url: string,
  body: unknown,
  what: string,
  fetchImpl: Fetch,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new BrokerError(`${what} could not be reached (${String(cause)}).`, { status: 0 });
  }
  return await unwrap(response, what);
}

export async function brokerConfig(
  url: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<BrokerConfig> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/config`, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new BrokerError(`${url} could not be reached (${String(cause)}).`, { status: 0 });
  }
  const data = await unwrap(response, url);

  const clientId = str(data['client_id']);
  if (!clientId) {
    throw new BrokerError(`${url} did not return a client id.`, { status: response.status });
  }

  const capacity = data['capacity'];
  return {
    clientId,
    scopesSupported: strings(data['scopes_supported']),
    identityScopes: strings(data['identity_scopes']),
    open: data['status'] !== 'closed',
    notice: str(data['notice']),
    docsUrl: str(data['docs_url']),
    capacity:
      capacity !== null && typeof capacity === 'object'
        ? {
            accounts: Number((capacity as Record<string, unknown>)['accounts']) || 0,
            cap: Number((capacity as Record<string, unknown>)['cap']) || 0,
          }
        : undefined,
  };
}

export async function brokerExchange(
  url: string,
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: Fetch = globalThis.fetch,
): Promise<BrokerTokens> {
  return (await post(
    `${url}/exchange`,
    { code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri },
    url,
    fetchImpl,
  )) as BrokerTokens;
}

export async function brokerRefresh(
  url: string,
  input: { refreshToken: string; idToken?: string | undefined },
  fetchImpl: Fetch = globalThis.fetch,
): Promise<BrokerTokens> {
  // The assertion goes in a header rather than the body so the broker can
  // attribute and rate-limit the call before it parses anything, and so it does
  // not land in whatever logs request bodies.
  return (await post(
    `${url}/refresh`,
    { refresh_token: input.refreshToken },
    url,
    fetchImpl,
    input.idToken ? { authorization: `Bearer ${input.idToken}` } : {},
  )) as BrokerTokens;
}
