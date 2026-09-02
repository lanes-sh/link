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
      // two workspaces two accounts instead of one overwritten twice: the
      // reconnect match below is on the account, so without it the second
      // connect repairs the first row rather than adding one. It used to reach
      // the id as well, back when the id was slugified from this.
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
 * `lan` for a surface built into Lanes, `con` for somebody's account.
 *
 * The prefix is the only thing an id says, and it says the one thing that is
 * true forever: whether there is a vendor behind this row. Everything else a
 * reader wants — whose mailbox, what the operator calls it — is `account` and
 * `label`, one field each, both changeable without moving a reference.
 */
export const OWNER_ID_PREFIX = 'lan';
export const ACCOUNT_ID_PREFIX = 'con';

/**
 * The next free connection id.
 *
 * **Opaque, where this used to derive the id from the account.**
 * `ada.lovelace@example.com` became `ada_lovelace`, on the reasoning that the
 * local part tells accounts apart in practice. It does not: the same name at
 * two domains produced `ada_lovelace` and `ada_lovelace2`, and an id that half
 * describes its account is worse than one that does not, because it invites
 * being trusted. What made that concrete is that the id is the whole of the
 * `connection` enum a model chooses from.
 *
 * So the id is a key and nothing else. `account` carries the identity the
 * provider reports and `label` the operator's own word, which means a `relabel`
 * never moves a `credential_ref`, a blob path, or a grant.
 *
 * **A leading letter, not a bare number.** `id: 001` parses as the integer `1`
 * in YAML, so `gmail.001` in a grant would match nothing and every id would need
 * quoting forever. `con1` is a string unconditionally.
 *
 * Numbers are never reused: the highest taken plus one, so an id that appears
 * in an audit log years later still means the row it meant then.
 */
export function nextConnectionId(taken: readonly string[], owner: boolean): string {
  const prefix = owner ? OWNER_ID_PREFIX : ACCOUNT_ID_PREFIX;
  const pattern = new RegExp(`^${prefix}([0-9]+)$`);

  let highest = 0;
  for (const id of taken) {
    const match = pattern.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  return `${prefix}${highest + 1}`;
}
