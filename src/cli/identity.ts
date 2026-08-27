import type { IdentityDeclaration, ProviderManifest } from '#connectivity';

/**
 * Working out whose account was just authorised.
 *
 * A connection list that reads `Gmail main`, `Gmail main2`, `Gmail main3`
 * cannot answer the one question it exists to answer. Worse, without an
 * identity there is no way to tell a *reconnect* from a *new account*, so
 * re-running `connect` after a failed attempt appends another row instead of
 * repairing the one already there — which is precisely how `main3` came to
 * exist.
 *
 * Everything here is best-effort. A provider that declares no identity, or
 * whose probe fails, falls back to asking the operator: a label is worth
 * having, never worth failing a connect over.
 */

/** Walk a dotted path, tolerating the first array element on the way. */
export function pluck(value: unknown, path: string): string | null {
  let current: unknown = value;

  for (const segment of path.split('.')) {
    if (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }

  if (Array.isArray(current)) current = current[0];
  return typeof current === 'string' && current.length > 0 ? current : null;
}

/** The header an OAuth or bearer provider's probe carries. */
async function bearerHeaders(probe: IdentityProbe): Promise<RequestInit> {
  const token = await probe.accessToken();
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

export interface IdentityProbe {
  /** A valid upstream access token, if the provider authenticates. */
  readonly accessToken: () => Promise<string | null>;
  /**
   * Put this connection's credential on a request, whatever method it is.
   *
   * Supplied where `accessToken` cannot answer. A stored `api_key`, `header` or
   * `basic` credential is not a bearer token and `bearerToken` throws for all
   * three — under a comment calling the branch unreachable, which it is on an
   * mcp connector and is not on an http one. The throw was caught by the
   * catch-all below, so an `identity: { kind: http }` block on the commonest
   * custom shape there is — a REST API behind an API key — never worked and
   * never said so: the operator was asked to name the account by hand on every
   * reconnect, and a different answer each time is a new row rather than a
   * repair.
   */
  readonly authorize?: (request: Request) => Promise<Request>;
  /** Call a capability on the upstream MCP server. */
  readonly callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Ask the connector, for a protocol whose identity is not a URL away. */
  readonly identify?: () => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

export async function resolveAccount(
  manifest: ProviderManifest,
  probe: IdentityProbe,
): Promise<string | null> {
  const identity: IdentityDeclaration | undefined = manifest.identity;
  if (!identity) return null;

  try {
    if (identity.kind === 'connector') {
      return (await probe.identify?.()) ?? null;
    }

    if (identity.kind === 'http') {
      const send = probe.fetch ?? globalThis.fetch;

      // `authorize` where the caller supplied one, because it is the same
      // switch the dispatch path uses and knows every method. The token is the
      // fallback rather than the other way round only because the OAuth
      // providers reached here first; both end at the same header for them.
      const response = probe.authorize
        ? await send(await probe.authorize(new Request(identity.url)))
        : await send(identity.url, await bearerHeaders(probe));
      if (!response.ok) return null;

      const body = await response.json();
      const primary = pluck(body, identity.field);
      if (!primary || !identity.qualifier) return primary;

      // `alice (Acme)` rather than `alice`. The bracketed half is what makes
      // two workspaces two accounts instead of one overwritten twice, and it
      // survives into the connection id because `idFromAccount` slugifies the
      // whole string when there is no `@` in it — `alice_acme`, which is a row
      // somebody can read in `status`.
      const qualifier = pluck(body, identity.qualifier);
      return qualifier ? `${primary} (${qualifier})` : primary;
    }

    if (!probe.callTool) return null;
    const result = await probe.callTool(identity.tool, identity.arguments);

    // MCP results arrive as content blocks; the useful part is usually JSON in
    // a text block, so try that before falling back to the raw shape.
    const text = pluck(result, 'content.text');
    if (text) {
      try {
        return pluck(JSON.parse(text), identity.field) ?? text;
      } catch {
        return text;
      }
    }
    return pluck(result, identity.field);
  } catch {
    return null;
  }
}

/**
 * Turn an account into a connection id.
 *
 * `ada.lovelace@example.com` becomes `ada_lovelace`, which is what appears in
 * `credential_ref` and in the agent's `connection` argument. The local part is
 * enough to tell accounts apart in practice, and the full address is still
 * right there in `account` when it is not.
 */
export function idFromAccount(account: string, taken: readonly string[] = []): string {
  const local = account.includes('@') ? (account.split('@')[0] ?? account) : account;

  const base =
    local
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'main';

  if (!taken.includes(base)) return base;

  // A genuine collision — two accounts sharing a local part, e.g. the same
  // name at two domains. Suffixing beats overwriting someone else's credential.
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
