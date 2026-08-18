import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidSecretRef,
  isValidSecretRef,
  type SecretRef,
  type SecretStore,
} from '#secrets';

/**
 * Google Secret Manager credential store — the `cloud` target's adapter.
 *
 * Over REST with `fetch`, and with no dependency, following the precedent set
 * when Gmail and Drive moved to their REST APIs: the client library exists to
 * wrap an HTTP call this file makes in four lines, and it would pull a
 * dependency tree into a process that holds live refresh tokens. `bunfig.toml`
 * imposes a seven-day release-age floor, so the library would also have to be
 * a week old before a deploy could use it.
 *
 * What this adapter provides that the file adapter cannot: the deployed target
 * scales to zero and has no persistent disk, so a credential has to outlive the
 * container. Encryption at rest is Google's, and the same limitation the file
 * adapter states applies here too — a credential in use is plaintext in memory.
 *
 * IAM, not code, is the boundary, and every grant a revision gets is bound to a
 * named secret: `roles/secretmanager.secretAccessor` on each ref it reads, and
 * `roles/secretmanager.secretVersionAdder` on each one it rotates — the vault
 * document (ADR-022) and the OAuth tokens it refreshes while serving (ADR-026).
 * `secrets.create` is the half that stays with the operator, because it is
 * project-level: an instance holding it could mint credential references of its
 * own, and that is the line, not writing.
 *
 * Read used to be project-level too, on the argument that `secrets.create` was
 * the only line worth drawing. The argument holds and the grant still did not:
 * a deploy can be pointed at a project that holds other things, and nothing on
 * the serving path ever needed the reach — reads go by explicit ref, `list()` is
 * a CLI call, and `secretAccessor` never carried `secrets.list` anyway. The set
 * is derived at deploy time by `readableRefs`.
 *
 * `set` is written around that split — see its own note.
 */

const API = 'https://secretmanager.googleapis.com/v1';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * `/` is legal in a `SecretRef` and illegal in a Secret Manager id, which
 * allows only `[A-Za-z0-9_-]`. `__` reads well and keeps `gmail/main` legible
 * in the console as `gmail__main`.
 *
 * The encoding is confined to this file. Nothing outside the adapter ever sees
 * a mangled reference, and `list()` hands back real refs.
 */
const SEPARATOR = '__';

/** Secret Manager's own constraint on an id, checked before the round trip. */
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function encodeRef(ref: SecretRef): string {
  assertValidSecretRef(ref);
  const id = ref.replaceAll('/', SEPARATOR);

  // Verified by round trip rather than by a rule about underscores, because
  // the rule has more cases than it looks like: `a/b__c` and `a/b_/c` both
  // encode to something that decodes back to a *different* reference. Refusing
  // is right — the alternative is two credentials silently sharing one secret.
  if (decodeRef(id) !== ref) {
    throw new Error(
      `Credential reference ${JSON.stringify(ref)} cannot be stored in Secret Manager: ` +
        `"${SEPARATOR}" separates its segments, so a segment may not contain "${SEPARATOR}" ` +
        'or end in "_". Rename the reference.',
    );
  }
  if (!SECRET_ID_PATTERN.test(id)) {
    throw new Error(
      `Credential reference ${JSON.stringify(ref)} encodes to ${JSON.stringify(id)}, ` +
        'which is not a valid Secret Manager id ([A-Za-z0-9_-], 255 characters).',
    );
  }
  return id;
}

export function decodeRef(secretId: string): string {
  return secretId.split(SEPARATOR).join('/');
}

/** How the adapter gets an OAuth access token for the Secret Manager API. */
export interface AccessTokenSource {
  token(): Promise<string>;
}

export interface GcpSecretManagerOptions {
  /** The Google Cloud project holding the secrets. */
  readonly project: string;
  /**
   * Where the token comes from. Defaults to Application Default Credentials:
   * `GOOGLE_ACCESS_TOKEN`, then `GOOGLE_APPLICATION_CREDENTIALS`, then the
   * gcloud well-known file, then the metadata server.
   */
  readonly tokens?: AccessTokenSource;
  readonly fetch?: typeof globalThis.fetch;
  readonly env?: Record<string, string | undefined>;
}

export class GcpSecretManagerStore implements SecretStore {
  readonly #project: string;
  readonly #tokens: AccessTokenSource;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GcpSecretManagerOptions) {
    if (!options.project) {
      throw new Error(
        'The gcp-secret-manager credential adapter needs a project. ' +
          'Set `credentials.project` on the target.',
      );
    }
    this.#project = options.project;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#tokens =
      options.tokens ??
      new ApplicationDefaultCredentials({
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
  }

  async get(ref: SecretRef): Promise<string | null> {
    const response = await this.#call(
      'GET',
      `/projects/${this.#project}/secrets/${encodeRef(ref)}/versions/latest:access`,
    );

    // A ref with no secret, and a ref whose secret has no live version, are the
    // same answer to the caller: nothing is stored.
    if (response.status === 404) return null;
    const body = await this.#json<{ payload?: { data?: string } }>(response, `read ${ref}`);

    const data = body.payload?.data;
    return data === undefined ? null : Buffer.from(data, 'base64').toString('utf8');
  }

  /**
   * The same read as `get`, with the value dropped.
   *
   * It used to fetch version *metadata* instead, on the reasoning that an
   * existence check should not pull plaintext across the network. That reads
   * well and cost a deployment: metadata needs `secretmanager.versions.get`,
   * and the role a revision is granted — `roles/secretmanager.secretAccessor` —
   * contains exactly `secretmanager.versions.access` and not that. So every
   * deployed instance died on its boot reconcile with a 403 naming a permission
   * nobody had asked for, on the one call that was trying to be frugal.
   *
   * The alternative was granting `roles/secretmanager.viewer` alongside, which
   * would let the revision enumerate every secret in the project — including
   * those of whatever else shares it. Paying one payload read to avoid that is
   * the right way round, and the caller is authorised to read the value anyway:
   * a `has` that returns true is followed by a `get` in every case there is.
   */
  async has(ref: SecretRef): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }

  /**
   * Add a version, and create the container only when there is none.
   *
   * The order is the whole point, and it used to be the other way round. Create
   * first, tolerate `ALREADY_EXISTS`, then add — which reads as harmless and
   * asks every writer for the permission only a *first* writer needs. Secret
   * Manager checks IAM before existence, so an identity holding
   * `secretVersionAdder` on the secret and nothing else does not get 409 back
   * from that create. It gets 403, and the write fails having been authorised
   * for the only call it was going to make.
   *
   * Which is a deployed revision, on the path that refreshes an OAuth token:
   * reading mail persists a rotated access token, so every read past the first
   * hour died on `secretmanager.secrets.create` — a permission deliberately
   * never granted, because it is project-level and would let a revision mint
   * credential references of its own.
   *
   * The race the old comment describes still cannot break this: two writers
   * both 404, both create, the loser gets `ALREADY_EXISTS`, and both add.
   */
  async set(ref: SecretRef, value: string): Promise<void> {
    const id = encodeRef(ref);
    const version = `/projects/${this.#project}/secrets/${id}:addVersion`;
    const payload = { payload: { data: Buffer.from(value, 'utf8').toString('base64') } };

    const added = await this.#call('POST', version, payload);
    if (added.status !== 404) {
      await this.#json(added, `write ${ref}`, ref);
      return;
    }

    const created = await this.#call(
      'POST',
      `/projects/${this.#project}/secrets?secretId=${encodeURIComponent(id)}`,
      { replication: { automatic: {} } },
    );
    if (!created.ok && created.status !== 409) {
      await this.#json(created, `create secret for ${ref}`, ref);
    }

    await this.#json(await this.#call('POST', version, payload), `write ${ref}`, ref);
  }

  async delete(ref: SecretRef): Promise<void> {
    // The whole secret, not the latest version: a version-level delete would
    // leave `list` reporting a ref that `get` cannot read.
    const response = await this.#call(
      'DELETE',
      `/projects/${this.#project}/secrets/${encodeRef(ref)}`,
    );
    if (response.status === 404) return; // Deleting what is not there is a no-op.
    await this.#json(response, `delete ${ref}`);
  }

  async list(prefix?: string): Promise<SecretRef[]> {
    const refs: SecretRef[] = [];
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);

      const response = await this.#call('GET', `/projects/${this.#project}/secrets?${query}`);
      const body = await this.#json<{
        secrets?: { name?: string }[];
        nextPageToken?: string;
      }>(response, 'list secrets');

      for (const secret of body.secrets ?? []) {
        const id = secret.name?.split('/').pop();
        if (!id) continue;

        const ref = decodeRef(id);
        // A project may hold secrets this system did not write — a Cloud Build
        // key, another app's token. Anything that does not decode to a valid
        // reference is not ours, and is skipped rather than reported.
        if (!isValidSecretRef(ref)) continue;
        if (prefix && !ref.startsWith(prefix)) continue;
        refs.push(ref);
      }

      pageToken = body.nextPageToken;
    } while (pageToken);

    return refs.sort();
  }

  async #call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#tokens.token();
    return this.#fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * Parse a response, or fail with what Google actually said.
   *
   * A 403 here is nearly always a missing IAM role, and the API says which
   * permission was denied. Swallowing that in favour of "request failed" turns
   * a one-line fix into an afternoon.
   */
  async #json<T>(response: Response, action: string, ref?: SecretRef): Promise<T> {
    const text = await response.text();

    if (!response.ok) {
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
        if (parsed.error?.message) {
          detail = parsed.error.status
            ? `${parsed.error.status}: ${parsed.error.message}`
            : parsed.error.message;
        }
      } catch {
        // Not JSON — an HTML error page from a proxy, most likely. Keep it raw.
      }
      const hint = response.status === 403 && ref ? grantHint(detail, ref) : '';
      throw new Error(
        `Secret Manager could not ${action} (HTTP ${response.status}). ${detail}${hint}`,
      );
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}

/**
 * The half of a denied write Google cannot know.
 *
 * It names the permission, which is exact and is not an instruction. This
 * surfaces to an agent holding no cloud context at all — a refused token
 * rotation reaches whoever asked to read their mail — so the message has to
 * carry the command rather than the IAM vocabulary that fixes it.
 *
 * Both cases are one situation seen from either side: a credential the revision
 * was never bound to, which is what a connection made since the last deploy
 * looks like.
 */
function grantHint(detail: string, ref: SecretRef): string {
  if (detail.includes('versions.add')) {
    return (
      ` This identity may read "${ref}" and not rotate it. A deployment binds that per secret,` +
      ' so a connection made since the last one has no binding yet: run `lanes link deploy`.'
    );
  }
  if (detail.includes('secrets.create')) {
    return (
      ` Nothing is stored at "${ref}" yet, and creating a credential reference is the operator's` +
      ' to do, never a running instance\'s: run `lanes link deploy`, or `lanes link secrets push`' +
      ' from a target that holds it.'
    );
  }
  return '';
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * Application Default Credentials, the subset that matters here.
 *
 * Resolution order is Google's own, so a machine already set up for `gcloud`
 * needs no configuration:
 *
 *   1. `GOOGLE_ACCESS_TOKEN` — an explicit override, and what CI usually has.
 *   2. `GOOGLE_APPLICATION_CREDENTIALS` — a service account key file.
 *   3. `~/.config/gcloud/application_default_credentials.json` — `gcloud auth
 *      application-default login`.
 *   4. The metadata server — Cloud Run, and every other GCP compute surface.
 *
 * Workload identity federation and impersonation are not implemented. They
 * would each be a further exchange, and neither is reachable from the two
 * places this runs: an operator's laptop and Cloud Run.
 */
export class ApplicationDefaultCredentials implements AccessTokenSource {
  readonly #fetch: typeof globalThis.fetch;
  readonly #env: Record<string, string | undefined>;
  #cached: CachedToken | undefined;

  constructor(
    options: { fetch?: typeof globalThis.fetch; env?: Record<string, string | undefined> } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#env = options.env ?? (process.env as Record<string, string | undefined>);
  }

  async token(): Promise<string> {
    const override = this.#env['GOOGLE_ACCESS_TOKEN'];
    if (override) return override;

    // Refreshed a minute early: a token that expires mid-request fails the
    // request, and the retry would land in the same window.
    if (this.#cached && this.#cached.expiresAt > Date.now() + 60_000) return this.#cached.value;

    const fresh = await this.#mint();
    this.#cached = fresh;
    return fresh.value;
  }

  async #mint(): Promise<CachedToken> {
    const keyFile = this.#env['GOOGLE_APPLICATION_CREDENTIALS'];
    if (keyFile) return this.#fromKeyFile(keyFile);

    const wellKnown = join(
      this.#env['CLOUDSDK_CONFIG'] ?? join(homedir(), '.config', 'gcloud'),
      'application_default_credentials.json',
    );
    if (await Bun.file(wellKnown).exists()) return this.#fromKeyFile(wellKnown);

    return this.#fromMetadataServer();
  }

  async #fromKeyFile(path: string): Promise<CachedToken> {
    let key: Record<string, string>;
    try {
      key = (await Bun.file(path).json()) as Record<string, string>;
    } catch (error) {
      throw new Error(`Could not read Google credentials from ${path}: ${(error as Error).message}`);
    }

    if (key['type'] === 'authorized_user') {
      return this.#exchange(new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: key['client_id'] ?? '',
        client_secret: key['client_secret'] ?? '',
        refresh_token: key['refresh_token'] ?? '',
      }), path);
    }

    if (key['type'] === 'service_account') {
      return this.#exchange(new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwtAssertion(key),
      }), path);
    }

    throw new Error(
      `${path}: unsupported Google credential type ${JSON.stringify(key['type'] ?? 'unknown')}. ` +
        'Expected "authorized_user" or "service_account".',
    );
  }

  async #exchange(body: URLSearchParams, source: string): Promise<CachedToken> {
    const response = await this.#fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Could not exchange the credentials in ${source} for a token: ${text.slice(0, 300)}`);
    }
    return toCachedToken(JSON.parse(text) as { access_token?: string; expires_in?: number }, source);
  }

  async #fromMetadataServer(): Promise<CachedToken> {
    let response: Response;
    try {
      response = await this.#fetch(METADATA_TOKEN_URL, {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // The last stop in the chain, so this is where "no credentials at all"
      // surfaces — say what to do rather than reporting a DNS failure for a
      // hostname the operator has never heard of.
      throw new Error(
        'No Google credentials found. On Cloud Run the metadata server supplies them; ' +
          'locally run `gcloud auth application-default login`, or set ' +
          'GOOGLE_APPLICATION_CREDENTIALS to a service account key, or GOOGLE_ACCESS_TOKEN directly.',
      );
    }

    if (!response.ok) {
      throw new Error(
        `The metadata server refused a token (HTTP ${response.status}). ` +
          'Check the service account attached to this revision.',
      );
    }
    return toCachedToken(
      (await response.json()) as { access_token?: string; expires_in?: number },
      'the metadata server',
    );
  }
}

function toCachedToken(
  body: { access_token?: string; expires_in?: number },
  source: string,
): CachedToken {
  if (!body.access_token) throw new Error(`${source} returned no access token`);
  return {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

/** The signed assertion a service account key trades for an access token. */
function signJwtAssertion(key: Record<string, string>): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key['client_email'],
    scope: CLOUD_PLATFORM_SCOPE,
    aud: key['token_uri'] ?? OAUTH_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;

  const signature = createSign('RSA-SHA256')
    .update(body)
    .sign(key['private_key'] ?? '', 'base64url');

  return `${body}.${signature}`;
}
